<?php
// stt-proxy.php: Cartesia's batch STT interface (POST /stt) on top of the ink-2 websocket.
// Same contract as stt-proxy/server.ts, as one dependency-free file for an ordinary PHP webhost
// (PHP >= 7.4 with openssl). Needed because SpacetimeDB procedures may not call localhost/private
// addresses, so the proxy must live on a public HTTPS host. See README "STT decision".
//
// Deploy: upload this file. Then set the module env STT_BASE_URL=https://your.host/stt-proxy.php
// (the module calls `${STT_BASE_URL}/stt?...`, which reaches this file via PATH_INFO).
// If your host strips the Authorization header, add to .htaccess:
//   RewriteEngine On
//   RewriteRule .* - [E=HTTP_AUTHORIZATION:%{HTTP:Authorization}]
//
// Request (same as https://api.cartesia.ai/stt):
//   POST .../stt?encoding=pcm_s16le&sample_rate=16000
//   Authorization: Bearer <CARTESIA_API_KEY>   (forwarded as the websocket X-API-Key)
//   Cartesia-Version: 2026-08-14
//   multipart/form-data: file=<raw PCM>, model=ink-2, language=en
// Response 200: {"type":"transcript","request_id":..,"text":..,"language":..,"duration":..}
//
// Unlike server.ts there is no warm socket pool (PHP is per request), so each call pays the
// websocket connect time (~0.5-0.8 s).

declare(strict_types=1);

const CARTESIA_HOST = 'api.cartesia.ai';
// Testing only: STT_PROXY_UPSTREAM=tcp://host:port points the websocket at a fake server.
define('UPSTREAM', getenv('STT_PROXY_UPSTREAM') ?: 'ssl://' . CARTESIA_HOST . ':443');
const DEFAULT_VERSION = '2026-08-14';
const FRAME_MS = 100;
const TIMEOUT_S = 15;
const RAW_ENCODINGS = ['pcm_s16le' => 2, 'pcm_s32le' => 4, 'pcm_f16le' => 2, 'pcm_f32le' => 4, 'pcm_mulaw' => 1, 'pcm_alaw' => 1];

final class HttpError extends Exception
{
    public int $status;
    public string $errorCode;
    public function __construct(int $status, string $message, string $errorCode = 'proxy_error')
    {
        parent::__construct($message);
        $this->status = $status;
        $this->errorCode = $errorCode;
    }
}

function send_json(int $status, array $body): void
{
    http_response_code($status);
    header('Content-Type: application/json');
    echo json_encode($body, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
}

function header_value(string $name): string
{
    $key = 'HTTP_' . strtoupper(str_replace('-', '_', $name));
    foreach ([$key, 'REDIRECT_' . $key] as $k) {
        if (!empty($_SERVER[$k])) return (string) $_SERVER[$k];
    }
    if (function_exists('getallheaders')) {
        foreach (getallheaders() as $k => $v) {
            if (strcasecmp((string) $k, $name) === 0) return (string) $v;
        }
    }
    return '';
}

// ---------------------------------------------------------------- minimal websocket client

final class WsClient
{
    /** @var resource */
    private $sock;
    private string $buf = '';

    public function __construct(string $host, string $pathAndQuery, array $headers)
    {
        $ctx = stream_context_create(['ssl' => ['verify_peer' => true, 'verify_peer_name' => true, 'SNI_enabled' => true]]);
        $sock = @stream_socket_client(UPSTREAM, $errno, $errstr, TIMEOUT_S, STREAM_CLIENT_CONNECT, $ctx);
        if (!$sock) throw new HttpError(502, "connect to $host failed: $errstr");
        stream_set_timeout($sock, TIMEOUT_S);
        $this->sock = $sock;

        $key = base64_encode(random_bytes(16));
        $req = "GET $pathAndQuery HTTP/1.1\r\nHost: $host\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
            . "Sec-WebSocket-Key: $key\r\nSec-WebSocket-Version: 13\r\n";
        foreach ($headers as $k => $v) $req .= "$k: $v\r\n";
        $this->write($req . "\r\n");

        $head = '';
        while (strpos($head, "\r\n\r\n") === false) {
            $chunk = fread($this->sock, 8192);
            if ($chunk === false || $chunk === '') throw new HttpError(502, 'websocket handshake: no response');
            $head .= $chunk;
        }
        [$head, $rest] = explode("\r\n\r\n", $head, 2);
        $this->buf = $rest;
        if (!preg_match('#^HTTP/1\.1 101#', $head)) {
            $status = preg_match('#^HTTP/\S+ (\d{3})#', $head, $m) ? (int) $m[1] : 502;
            throw new HttpError($status === 101 ? 502 : $status, 'websocket rejected: ' . strtok($head, "\r\n"));
        }
        $accept = base64_encode(sha1($key . '258EAFA5-E914-47DA-95CA-C5AB0DC85B11', true));
        if (stripos($head, "Sec-WebSocket-Accept: $accept") === false) throw new HttpError(502, 'websocket handshake: bad accept key');
    }

    private function write(string $data): void
    {
        for ($off = 0, $len = strlen($data); $off < $len;) {
            $n = fwrite($this->sock, substr($data, $off));
            if ($n === false || $n === 0) throw new HttpError(502, 'websocket write failed');
            $off += $n;
        }
    }

    /** Client frames are always masked (RFC 6455). Opcode 1 = text, 2 = binary, 8 = close, 10 = pong. */
    public function send(int $opcode, string $payload): void
    {
        $len = strlen($payload);
        $head = chr(0x80 | $opcode);
        if ($len < 126) $head .= chr(0x80 | $len);
        elseif ($len < 65536) $head .= chr(0x80 | 126) . pack('n', $len);
        else $head .= chr(0x80 | 127) . pack('J', $len);
        $mask = random_bytes(4);
        $masked = $payload ^ str_repeat($mask, intdiv($len, 4) + 1);
        $this->write($head . $mask . substr($masked, 0, $len));
    }

    private function need(int $n): string
    {
        while (strlen($this->buf) < $n) {
            $chunk = fread($this->sock, 65536);
            if ($chunk === false || $chunk === '') {
                $meta = stream_get_meta_data($this->sock);
                throw new HttpError($meta['timed_out'] ? 504 : 502, $meta['timed_out'] ? 'ink-2 did not answer in time' : 'ink-2 websocket closed early');
            }
            $this->buf .= $chunk;
        }
        $out = substr($this->buf, 0, $n);
        $this->buf = (string) substr($this->buf, $n);
        return $out;
    }

    /** Next complete text message (control frames handled, fragments joined). */
    public function receiveText(): string
    {
        $message = '';
        while (true) {
            [$b1, $b2] = array_values(unpack('C2', $this->need(2)));
            $fin = ($b1 & 0x80) !== 0;
            $opcode = $b1 & 0x0f;
            $len = $b2 & 0x7f;
            if ($len === 126) $len = unpack('n', $this->need(2))[1];
            elseif ($len === 127) $len = unpack('J', $this->need(8))[1];
            $mask = ($b2 & 0x80) ? $this->need(4) : '';
            $payload = $len > 0 ? $this->need($len) : '';
            if ($mask !== '') $payload = substr($payload ^ str_repeat($mask, intdiv($len, 4) + 1), 0, $len);
            if ($opcode === 9) { $this->send(10, $payload); continue; } // ping -> pong
            if ($opcode === 10) continue;
            if ($opcode === 8) throw new HttpError(502, 'ink-2 websocket closed early');
            $message .= $payload;
            if ($fin) return $message;
        }
    }

    public function close(): void
    {
        try { $this->send(8, pack('n', 1000)); } catch (Throwable $e) {}
        fclose($this->sock);
    }
}

// ---------------------------------------------------------------- request handling

function handle_stt(): void
{
    $t0 = microtime(true);
    $auth = header_value('Authorization');
    $apiKey = trim((string) preg_replace('/^Bearer\s+/i', '', $auth));
    if ($apiKey === '') $apiKey = header_value('X-API-Key');
    if ($apiKey === '') throw new HttpError(401, 'missing Authorization: Bearer <api key>', 'unauthorized');

    if (empty($_FILES['file']) || ($_FILES['file']['error'] ?? UPLOAD_ERR_NO_FILE) !== UPLOAD_ERR_OK) {
        throw new HttpError(400, '`file` is required (multipart/form-data)', 'invalid_request');
    }
    $audio = (string) file_get_contents($_FILES['file']['tmp_name']);
    $model = (string) ($_POST['model'] ?? 'ink-2');
    $language = (string) ($_POST['language'] ?? 'en');
    $encoding = (string) ($_GET['encoding'] ?? 'pcm_s16le');
    $sampleRate = (int) ($_GET['sample_rate'] ?? 16000);
    if (!isset(RAW_ENCODINGS[$encoding])) throw new HttpError(400, 'only raw PCM encodings are supported by this proxy', 'invalid_request');
    if ($sampleRate <= 0) throw new HttpError(400, 'sample_rate must be positive', 'invalid_request');
    $version = header_value('Cartesia-Version') ?: DEFAULT_VERSION;

    $query = http_build_query(['model' => $model, 'encoding' => $encoding, 'sample_rate' => $sampleRate, 'cartesia_version' => $version]);
    $ws = new WsClient(CARTESIA_HOST, "/stt/websocket?$query", ['X-API-Key' => $apiKey]);
    $text = '';
    $requestId = '';
    try {
        $frame = max(1, (int) round($sampleRate * FRAME_MS / 1000)) * RAW_ENCODINGS[$encoding];
        for ($i = 0, $n = strlen($audio); $i < $n; $i += $frame) $ws->send(2, substr($audio, $i, $frame));
        $ws->send(1, 'finalize');
        while (true) {
            $msg = json_decode($ws->receiveText(), true);
            if (!is_array($msg)) continue;
            if (!empty($msg['request_id'])) $requestId = (string) $msg['request_id'];
            $type = $msg['type'] ?? '';
            if ($type === 'transcript' && !empty($msg['is_final']) && isset($msg['text'])) $text .= (string) $msg['text']; // deltas, as-is
            elseif ($type === 'flush_done') break;
            elseif ($type === 'error') throw new HttpError((int) ($msg['status_code'] ?? 502), (string) ($msg['message'] ?? 'ink-2 error'), (string) ($msg['error_code'] ?? 'proxy_error'));
        }
    } finally {
        $ws->close();
    }

    $duration = strlen($audio) / RAW_ENCODINGS[$encoding] / $sampleRate;
    header('X-Proxy-Ms: ' . (int) round((microtime(true) - $t0) * 1000));
    send_json(200, ['type' => 'transcript', 'request_id' => $requestId, 'text' => trim($text), 'language' => $language, 'duration' => $duration]);
}

$path = rtrim((string) ($_SERVER['PATH_INFO'] ?? parse_url((string) ($_SERVER['REQUEST_URI'] ?? '/'), PHP_URL_PATH)), '/');
$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
try {
    if ($method === 'GET' && substr($path, -7) === '/health') {
        send_json(200, ['ok' => true]);
    } elseif ($method === 'POST' && substr($path, -4) === '/stt') {
        handle_stt();
    } else {
        send_json(404, ['error_code' => 'not_found', 'message' => 'only POST /stt']);
    }
} catch (HttpError $e) {
    send_json($e->status, ['error_code' => $e->errorCode, 'title' => 'STT proxy error', 'message' => $e->getMessage()]);
} catch (Throwable $e) {
    send_json(500, ['error_code' => 'proxy_error', 'title' => 'STT proxy error', 'message' => $e->getMessage()]);
}
