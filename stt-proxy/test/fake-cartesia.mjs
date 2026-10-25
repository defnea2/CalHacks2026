// Test helper: run `node test/fake-cartesia.mjs`, then start stt-proxy.php with
// STT_PROXY_UPSTREAM=tcp://127.0.0.1:9555 to check the websocket framing without Cartesia.
// Fake ink-2 websocket: checks auth + query, counts audio bytes, answers finalize with two
// fragmented-ish transcript deltas, a ping, and flush_done.
import { WebSocketServer } from 'ws';
const wss = new WebSocketServer({ port: 9555 });
wss.on('connection', (ws, req) => {
  const url = new URL(req.url, 'http://x');
  console.log('conn', url.pathname, url.searchParams.get('model'), url.searchParams.get('sample_rate'), 'key', req.headers['x-api-key']);
  let bytes = 0, frames = 0;
  ws.on('message', (d, isBinary) => {
    if (isBinary) { bytes += d.length; frames++; return; }
    if (d.toString() === 'finalize') {
      console.log('finalize after', frames, 'frames', bytes, 'bytes');
      ws.ping();
      ws.send(JSON.stringify({ type: 'transcript', is_final: true, text: ' I got ' + bytes + ' bytes,', request_id: 'r1' }));
      ws.send(JSON.stringify({ type: 'transcript', is_final: false, text: ' ignored' }));
      ws.send(JSON.stringify({ type: 'transcript', is_final: true, text: ' long ' + 'x'.repeat(70000) + ' end.', request_id: 'r1' }));
      ws.send(JSON.stringify({ type: 'flush_done', request_id: 'r1' }));
    }
  });
});
console.log('fake on 9555');
