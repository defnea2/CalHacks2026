# Internal latency of the voice pipeline (measured 2026-10-25)

Scope: every latency in the voice path that is **not** waiting on Cartesia (STT, TTS) or the LLM.
External spans are measured too, but only so they can be subtracted.

**Result in one line.** From the moment the student stops speaking to the first tutor audio, the
system adds **about 100 ms of its own overhead** (p50 101 ms, p95 113 ms, n = 12 turns, one
session at a time). The rest is policy waits (300 ms phrase silence, 700 ms turn silence) and
external HTTP. The biggest *internal* costs are the 40 ms playback lead, the SpacetimeDB
confirmed-reads delay on every commit-to-subscriber hop (~5.5 ms each), and ~7 ms of `withTx`
overhead per procedure transaction. Two problems that are not "overhead" but scheduling: the
preemptive LLM start never fires with the default timings, and procedures are capped at 10 in
parallel, so with 4 parallel sessions TTS jobs wait up to 0.7 s.

## Setup and method

| | |
| --- | --- |
| Stack | Local SpacetimeDB 2.13 (shared server, own DB `tutor-lat`), worker on branch `agent/voice-tutor-latency`, Vite client on :5190, headless Chrome 154 with fake microphone, MacBook (10 cores) on a phone hotspot |
| STT | Cartesia batch `ink-whisper` (`STT_BASE_URL=https://api.cartesia.ai`), real |
| TTS | Cartesia `sonic-3.6` `/tts/bytes`, real |
| LLM | **Local fake** OpenAI-compatible streaming server (`e2e/latency/fake-llm.mjs`, TTFT 0, 12 ms per word token, 4 sentences + one `show_board_item` call). The worker's base URL is overridden with `LLM_BASE_URL` (branch only) |
| Fixtures | `e2e/fixtures/{correct-step,wrong-step,um-pauses,noisy,interrupt}.wav` (generated speech), 2 runs each = 10 sessions, 12 answered turns, 48 sentences. Plus 4 parallel sessions, and a reducer micro-benchmark |
| Instrumentation (temporary, this branch only) | Module: `LAT {...}` log lines with `Date.now()` and the tx timestamp (`spacetimedb/src/lat.ts`) at reducer entry, procedure entry/exit, HTTP start/end, inserts. Worker: `LAT` lines (`worker/src/lat.ts`) for turn seen, buildContext, LLM request/first chunk/tokens, chunker output, addSentence/tool calls. Client: per-frame VAD timing (`window.__lat.frames`: worklet frame arrival, Silero inference time), `lat.vad` events with frame index, `lat.push` (per-chunk reducer round trip), `lat.audioIn`, `audio.scheduled` with context times |
| Collection | `e2e/latency/run.mjs` (puppeteer: create user, start session, start talking; in-page hooks on the session's own connection for row arrival + a MutationObserver for render times; CDP `Network.webSocketFrame*` for frame sizes; optional observer browser) |
| Join | `e2e/latency/analyze.mjs` joins client, module, worker and fake-LLM timestamps (same machine clock; browser `performance.timeOrigin + t`) |

Reproduce: start `node e2e/latency/fake-llm.mjs`, the worker with `SPACETIME_DB=tutor-lat LLM_BASE_URL=http://127.0.0.1:8799/v1`,
Vite on 5190, then `REPS=2 sh e2e/latency/batch.sh`, `K=4 sh e2e/latency/parallel.sh`,
`(cd worker && ./node_modules/.bin/tsx ../e2e/latency/bench-reducers.ts)`, `sh e2e/latency/net-probe.sh`,
and `node e2e/latency/analyze.mjs /tmp/lat/runs /tmp/lat/server.log /tmp/lat/worker.log /tmp/lat/fake-llm.log`.

Caveats: the browser's `Date.now()` and the module's `Date.now()` have 1 ms resolution, so
single-digit one-way numbers are ±1 ms. The fake microphone has no hardware input latency, and
headless Chrome reports `outputLatency` 39 ms. A real device adds both (typically 10–40 ms each),
and that is not counted below. The fake LLM's "generation" (~125 ms to the end of the first sentence) is counted as external.

## 1. Stage table (one session at a time unless noted)

All values in ms unless the name says bytes. n = number of samples.

### Capture and VAD (client)

| Stage | Method | n | p50 | p95 | max | Where the time goes |
| --- | --- | --- | --- | --- | --- | --- |
| Silero v5 inference per 32 ms frame | wrap `frameProcessor.modelProcessFunc` | 8024 | 1.1 | 2.4 | 7.3 | ONNX wasm, 1 thread. First frame 19 ms (warm-up) |
| Frame processing total (arrival → VAD machine done) | wrap `processFrame` | 8024 | 1.2 | 2.6 | 7.4 | inference + state machine, no backlog |
| Frame interval | arrival deltas | 8024 | 32.0 | 37.5 | 45.2 | 512-sample frames from the worklet (48 kHz → 16 kHz resampler, 128-sample render quanta). Jitter ≤ 13 ms, no frames lost |
| speech_start after first frame ≥ threshold | frame index | 18 | 128 | 128 | 128 | `VAD_MIN_SPEECH_MS=100` needs 4 frames (128 ms): 28 ms of quantisation |
| speech_start after acoustic onset | frame index vs first non-silent frame | 16 | 192 | 320 | 320 | Silero ramps up on weak onsets. Covered by the 320 ms pre-roll (pre-roll + candidate frames ≥ onset lag in every run), so no clipped words |
| Pre-roll actually sent | `vad.speech_start.prerollMs` | 18 | 320 | 320 | 320 | 10 frames (configured 300) |
| phrase_end after last voiced frame | frame index | 20 | 320 | 320 | 320 | `VAD_PHRASE_MS=300` → 10 frames = 320 ms: **+20 ms quantisation** |
| turn_end after last voiced frame | frame index | 12 | 704 | 704 | 704 | `VAD_TURN_MS=700` → 22 frames: **+4 ms** |
| barge-in after onset (tutor speaking) | frame index | 2 | 960 | 960 | 960 | `BARGE_IN_THRESHOLD 0.7` + `BARGE_IN_MIN_MS 400` (13 frames = 416 ms) + slow Silero ramp-up above 0.7 |

The decision itself costs ~1 ms of CPU after the frame arrives. The cost of VAD is entirely the configured silence windows plus ≤ 32 ms of frame quantisation.

### Smart Turn (semantic turn end, added 2026-10-24)

Pipecat Smart Turn v3.2 (`smart-turn-v3.2-cpu.onnx`, int8, 8.7 MB, BSD-2) runs in a Web Worker
on onnxruntime-web wasm (1 thread, SIMD) at every silence phrase end, on the turn's audio (last ≤ 8 s).
Headless Chrome on the same MacBook, `vad.smart_turn` / `smart_turn.ready` events:

| Stage | n | typical | range | Notes |
| --- | --- | --- | --- | --- |
| Model load (fetch + session + warm-up run) | 13 | 400 ms | 385–680 | fetch from `/vad/` ~35 ms; starts after the mic, turns end on silence until it is ready. 650–680 ms with 3 parallel Chromes |
| Log-mel features (TS, worker) | ~40 | 50 ms | 44–73 | 801 × FFT-400 + 80 mel bands |
| Inference (worker) | ~40 | 220 ms | 215–224 | Whisper-Tiny encoder on 8 s; node wasm gives the same ~215 ms |
| Request → verdict on the main thread | ~40 | 270 ms | 264–350 | so a verdict lands at ≈ 590 ms of silence (320 ms phrase end + 270 ms) |

Turn end = silence after the last voiced frame (`vad.turn_end.silenceMs`), `VAD_TURN_MS=900`:

| Scenario | silence only | Smart Turn | Verdicts (P complete) |
| --- | --- | --- | --- |
| correct-step | 928 | **608** | 0.98 |
| noisy | 928 | **608** | 0.89–0.92 |
| interrupt, 1st turn | 928 | **608** | 0.99 |
| interrupt, barge-in turn | 928 | 928 | 0.03–0.18 (question: "incomplete") |
| wrong-step | 928 | 928 | 1st sentence 0.95–0.97 but speech resumed after the 490 ms gap before the verdict (stale); last sentence 0.16–0.26 |
| um-pauses | 928, one turn | 928, **one turn** | "Um, so," 0.005; "…how many pieces." 0.90–0.93 (complete, but held by the 600 ms minimum silence, speech resumed after the 590 ms pause); last sentence 0.19–0.33 |

`SMART_TURN_MIN_SILENCE_MS` is 600, not 300: with 300 the um-pauses fixture splits into two turns
(the sentence before the 590 ms thinking pause is grammatically complete and scores 0.9). Since the
verdict needs ~590 ms of silence anyway, 600 costs only ~20 ms against 300 on the turns it shortens.
The model often scores the *last* sentence of these TTS child-voice fixtures low (0.16–0.33), so those
turns still wait for the 900 ms fallback.

### Upload transport (client → SpacetimeDB)

| Stage | Method | n | p50 | p95 | max | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| pushAudio call → reducer starts (one way) | client `Date.now()` vs tx timestamp | 320 | 1.2 | 2.3 | 3.6 | websocket + BSATN decode + scheduling |
| pushAudio call → promise resolved (round trip) | `lat.push` | 300 | 8.1 | 14.0 | 21.6 | of which ~5.5 ms is the confirmed-reads wait (see benchmark) |
| Bytes per chunk | | 300 | 5120 | 10240 | 25600 | 160 ms of PCM16 @16 kHz. First chunk carries pre-roll + candidate (up to 14 KB) |
| Websocket overhead per chunk | CDP frame size − PCM bytes | 320 | 45 B | 45 B | 76 B | BSATN envelope: 0.9 % of a chunk. Raw binary, no base64 |
| Final chunk committed after phrase_end | | 20 | 0.6 | 1.4 | 1.6 | The final chunk leaves in the same tick as phrase_end. **Chunk size adds no latency** (confirmed) |
| endTurn: turn_end → reducer starts | | 12 | 0.7 | 1.7 | 1.7 | |
| endTurn → turn `closing` visible in the client | row hook | 4 | 5.3 | 8.3 | 8.3 | |
| Reducer round trips (endTurn / markPlayed / reportNoise / interrupt) | `reducer.ok` | 12/44/12/2 | 8 / 8 / 12 / 10 | 10 / 17 / 16 / 10 | | |

No websocket backpressure: one 5 KB call every 160 ms is 32 KB/s, the calls never overlap (RTT 8 ms ≪ 160 ms).

### Scheduler and procedures (SpacetimeDB)

| Stage | Method | n | p50 | p95 | max | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| stt_job due → `transcribePhrase` starts | tx ts − `scheduledAt` | 20 | 3.0 | 4.8 | 5.4 | right after a publish the first jobs took 30–39 ms (cold instances) |
| tts_job due → `synthesizeSentence` starts | | 48 | 2.7 | 3.7 | 4.4 | |
| tts_job due → start, **4 sessions in parallel** | | 16 | 25 | 695 | 695 | procedure cap reached (below) |
| STT: entry → HTTP start | read `withTx` + concat + multipart | 20 | 8.5 | 11.1 | 17.7 | almost all of it is the `withTx` (join of ~20 audio_in chunks, ~90 KB) |
| STT: HTTP response → done | parse + `finishPhrase` `withTx` | 20 | 7.0 | 10.0 | 10.0 | |
| TTS: entry → HTTP start | one `withTx` that only checks `status = pending` | 48 | 7.7 | 13.0 | 22.6 | a read-only tx costs ~7 ms |
| TTS: response → `audio_out` insert | `res.bytes()` + tx start | 48 | 1.0 | 2.0 | 2.0 | |
| TTS: insert → commit done | | 48 | 5.0 | 8.0 | 12.0 | 165 KB row + 2 updates |
| `buildContext` procedure body | | 12 | 6.7 | 9.7 | 9.7 | |
| (external) STT HTTP, ink-whisper | | 20 | 292 | 671 | 748 | no correlation with phrase size (27–121 KB): RTT + server time |
| (external) TTS HTTP, one sentence (~3.5 s of audio) | | 48 | 532 | 805 | 851 | 4 parallel sessions: p50 1007 |

**Concurrency.** The TTS jobs of one utterance run in parallel (3–4 HTTP calls open at once in
every reply), and so do the jobs of different sessions, but only up to **10 procedures at a time**
(= the 10 CPU cores of this laptop; the server runs one procedure per instance). In the 4-session
run exactly 10 HTTP calls were open, and the next `tts_job` started within 5 ms of one finishing
(e.g. a job due at +1196 ms started at +1417 ms, 5 ms after another call returned). A procedure
blocked in `ctx.http.fetch` holds its slot for the whole HTTP call, so with 3+ students talking at
once, sentence 0 of one session can wait behind sentences 2–3 of another.

### Downlink and render

| Stage | Method | n | p50 | p95 | max | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| audio_out insert → client `onInsert` | module log in tx vs client | 48 | 15.6 | 21.5 | 27.3 | commit (~5) + confirmed reads (~5.5) + gzip + ws + gunzip + BSATN decode |
| audio_out commit done → client `onInsert` | | 48 | 9.2 | 14.2 | 15.3 | |
| PCM per sentence | | 48 | 168960 B | 211200 B | 218880 B | 24 kHz PCM16 = 48 KB/s, 3.5 s per sentence |
| Websocket frame per sentence | CDP | 48 | 164768 B | 203960 B | 210068 B | **gzip-compressed (tag 2), saving only 2.5 %**: PCM barely compresses |
| reply_sentence insert → client | addSentence tx → `onInsert` | 48 | 7.0 | 14.6 | 16.6 | |
| transcript (finishPhrase) → client | | 20 | 7.4 | 10.8 | 11.1 | |
| turn `ready` → client | | 12 | 6.5 | 10.8 | 10.8 | |
| board_item → client | | 12 | 8.3 | 25.1 | 25.1 | |
| Render: transcript row → caption in DOM | MutationObserver | 20 | 8.6 | 19.6 | 21.1 | React render |
| Render: board row → board item in DOM | | 12 | 8.1 | 17.1 | 17.1 | KaTeX |
| Render: play_start → tutor caption in DOM | | 44 | 3.9 | 6.3 | 7.2 | captions are reveal-synced to playback |
| Observer tab: session play_start → caption in observer DOM | 2nd browser | 8 | 10.8 | 23.9 | 23.9 | markPlayed reducer + fan-out + render |

Small rows reach a subscriber in ~7 ms; 165 KB audio rows in ~9 ms after commit. Fan-out to a second client costs nothing extra (the observer gets rows at the same time as the session tab).

### Worker

| Stage | Method | n | p50 | p95 | max | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| turn `ready` committed → worker `onUpdate` | | 12 | 5.5 | 10.8 | 10.8 | confirmed reads ~5.5 of it |
| seen → ReplyRun started | | 12 | 0.3 | 4.1 | 4.1 | |
| `buildContext` call → result | | 12 | 9.1 | 14.6 | 14.6 | 1 ms hop + 7 ms procedure + return |
| Prompt build (`buildMessages`) | | 12 | 0.1 | 0.2 | 0.2 | no image in these runs |
| `llm.stream()` → first request byte at the LLM | fake LLM | 12 | 2.5 | 3.8 | 3.8 | openai SDK; prompt ~9.6 KB JSON |
| Chunker look-ahead (sentence-final token → sentence emitted) | | 36 | 14.2 | 17.5 | 19.4 | **one token gap**: the chunker waits for the next non-space character. With a real model this is its inter-token time |
| chunk → addSentence sent | outbox | 36 | 0.1 | 0.7 | 0.7 | beginUtterance is long done by then |
| addSentence one way / round trip | | 48 | 1.3 / 7.4 | 1.8 / 14.9 | 2.0 / 16.7 | the worker does not wait for the ack before the next sentence's TTS starts |
| beginUtterance round trip | | 12 | 7.0 | 10.9 | 10.9 | overlaps the LLM call |
| Tool call: last argument byte → `tool_call` event | | 12 | 0.5 | 4.9 | 4.9 | only because the fake ends the stream right after the call (see finding F6) |
| Tool: event → reducer sent (outbox) / reducer round trip | | 12 | 6.3 / 8.8 | 10.4 / 15.4 | | |
| Tool event → board item in the student's DOM | | 12 | 27.1 | 39.7 | 39.7 | outbox + reducer + fan-out + KaTeX render |

### Playback (client)

| Stage | n | p50 | p95 | max | Notes |
| --- | --- | --- | --- | --- | --- |
| `onInsert` → AudioBuffer scheduled | 48 | 2.0 | 10.3 | 61.6 | the 61 ms case is a GC/main-thread hiccup |
| Decode + trim + fades + buffer (`prepMs`) | 48 | 0.8 | 3.5 | 4.3 | |
| Scheduled → first sentence starts (`PLAYBACK_LEAD_MS`) | 12 | 40 | 40 | 40 | a fixed 40 ms |
| `outputLatency` reported (headless) | 48 | 39 | 39 | 39 | after play_start, not counted |
| Extra gap between sentences beyond 200 ms | 36 | 0 | 0 | 0 | sentences 1..3 always arrived seconds before needed (parallel TTS) |
| Barge-in → local playback stopped | 2 | 0.3 | 0.3 | 0.3 | `source.stop()` in the same tick; server `playback_flush` arrives 10 ms later |
| Barge-in → `interrupt` reducer starts | 2 | 1.5 | 1.6 | 1.6 | |

### Reducer micro-benchmark (`bench-reducers.ts`, 60 calls per cell)

pushAudio round trip and "row visible at a second, subscribed connection", by payload and connection option:

| Option | 2 B | 5 KB | 14 KB | 32 KB | 64 KB |
| --- | --- | --- | --- | --- | --- |
| default (server-default confirmed reads, gzip) p50 / p95 | 7.7 / 14.7 | 8.4 / 14.4 | 9.8 / 17.9 | 9.0 / 17.1 | 10.5 / 17.9 |
| `withConfirmedReads(false)` p50 / p95 | **2.1 / 5.8** | **2.5 / 4.9** | **3.1 / 5.3** | **2.9 / 7.1** | **4.0 / 6.2** |
| `withConfirmedReads(true)` | 7.7 / 12.8 | 8.6 / 13.3 | 8.6 / 12.0 | 8.9 / 14.3 | 10.0 / 15.7 |
| `withCompression('none')` | 7.5 / 11.5 | 8.5 / 16.5 | 9.0 / 20.1 | 8.8 / 13.0 | 10.4 / 17.1 |

The server default is confirmed reads (wait until the transaction is durable, i.e. fsynced,
before sending updates). That is **~5.5 ms per commit → subscriber hop**, more than the whole
rest of the round trip. Payload size costs ~0.03 ms/KB. Compression makes no difference for
these sizes.

## 2. Waterfall of one typical turn

`wrong-step-2`, two phrases in one turn, close to the median (1492 ms from the end of speech to the first audio). Times in ms from the last voiced frame.

```
                                       0        300       600       900      1200     1500
turn-end path (policy)   701  [=========================================]                      VAD_TURN_MS 700 + 1 frame
  endTurn committed        1                                            |
STT path                                 (finished at ~700, hidden under the turn wait)
  phrase_end (policy)    321  [==================]
  final chunk + sched      4                     |
  stt proc -> HTTP        11                     |
  STT HTTP (external)     356                    [==================]
turn ready               702  ------------------------------------------>|
  worker sees ready        5                                             |
  buildContext            15                                             |=
  prompt + request         3                                             |
  LLM to sentence end    126  (external, fake)                           [=======]
  chunker look-ahead      14  (external*)                                        |
  addSentence + commit     2                                                     |
  tts sched + proc pre    16                                                     |=
  TTS HTTP (external)    549                                                     [=============================]
  audio_out -> client     17                                                                                   |=
  schedule + lead 40      43                                                                                   |==
first audio heard       1492
```

Breakdown of the 1492 ms: policy 701 (47 %), external 689 (TTS 549 + fake LLM 140, 46 %),
**internal 101 (7 %)**. The ~100 ms of internal time, for all 12 turns:

| Internal piece (critical path) | typical ms |
| --- | --- |
| Playback lead (`PLAYBACK_LEAD_MS`) | 40 |
| audio_out commit + confirmed reads + transfer + decode to the client | 16 |
| TTS procedure: `withTx` pre-check before the HTTP call | 8 |
| `buildContext` round trip | 9 |
| turn ready → worker (confirmed reads) | 6 |
| scheduler (tts) + addSentence + chunk → reducer | 5 |
| endTurn or final chunk + scheduler (stt) + STT `withTx` (whichever path is critical) | 2–12 |
| client scheduling + prep | 3 |
| frame quantisation of the silence windows (+20 phrase / +4 turn) | 4–20 (counted in "policy") |

Per-turn totals (speech end → first audio): p50 1429, p95 2104 (n = 12). Internal p50 101,
p95 113, max 113. When the STT path is critical (STT > ~380 ms), "policy" is 320 instead of 700
and the STT time takes its place. With 4 parallel sessions: internal p50 122, max 283 (the max
comes from the procedure cap).

## 3. Top internal time sinks (ranked)

1. **Scheduler cap under load: up to ~700 ms** (p95, 4 parallel sessions). Procedures hold one of 10 slots for the whole external HTTP call; each reply opens 4 TTS calls at once.
2. **Playback lead: 40 ms** fixed on every first sentence.
3. **Confirmed reads: ~5.5 ms on every commit → subscriber hop.** On the critical path at least 3 times (turn ready → worker, audio_out → client, buildContext's tx), plus every reducer round trip the client waits for (~11–20 ms per turn).
4. **`withTx` cost in procedures: ~7 ms per transaction**, even read-only. The critical path has 2–4 of them (STT read, STT finish, TTS pre-check, TTS insert): ~15–25 ms.
5. **Downlink of the first sentence's audio: ~16 ms** for 165 KB (commit + gzip that saves 2.5 % + ws + gunzip). Locally small; over the internet this is the item that grows (165 KB per sentence).
6. **Chunker look-ahead: one LLM inter-token gap** (14 ms with the fake; 10–40 ms with real models) before the first sentence can go to TTS.
7. **buildContext round trip: ~9 ms** after the turn is ready, although the context could be built before.
8. Frame quantisation of the silence windows: +20 ms on phrase end (300 → 320), +4 ms on turn end.

Everything else (VAD inference, encoding, websocket overhead, reducer one-way, render) is ≤ 10 ms and off the critical path or tiny.

### Scheduling findings (not overhead, but latency the system leaves on the table)

- **F1. Preemptive LLM never starts.** `PREEMPTIVE_SILENCE_MS=400` is counted from the last `speech_activity`, which is the final chunk, sent at phrase end, i.e. already 320 ms after the speech ended. So the earliest preemptive start is ~720 ms after speech end, *after* the turn end (704 ms). In 12 turns the worker logged 0 preemptive starts. Fix: count the silence from the speech end (final-chunk time minus `VAD_PHRASE_MS`, or a timestamp of the last voiced frame sent with the final chunk). Then, when STT is done in time, the LLM starts ~300 ms earlier. With a real model (TTFT 1.0–1.8 s) that is a direct ~300 ms saving per turn.
- **F2. The turn waits for STT in 4 of 12 turns** (STT HTTP > ~380 ms). The STT HTTP call starts only after the phrase end (a batch request), so on a slow day it adds 0–450 ms beyond the turn wait. Streaming STT (or the `ink-2` proxy at ~385 ms after finalize) moves it under the 700 ms wait.
- **F3. Whole-sentence TTS.** The first audio waits for the complete first sentence (TTS HTTP p50 532 ms for ~3.5 s of audio). That is external time, but the design choice decides it: streaming the first sentence in chunks would play after Cartesia's first byte (README: 0.37–0.54 s with the old setup; streaming endpoints are lower).
- **F4. TTS parallelism per reply is unbounded** (3–4 calls at once). Locally that hides sentences 1..n completely (0 ms extra gap), but it is what saturates the 10 procedure slots with several sessions, and it competes for the hotspot's bandwidth with sentence 0 (TTS HTTP p50 532 → 1007 ms with 4 sessions).
- **F5. Cold procedure instances.** Right after a publish the first `stt_job`/`tts_job`s started 30–39 ms after they were due instead of ~3 ms.
- **F6. Tool calls are emitted only when the next tool index starts or the stream ends** (`worker/src/llm.ts` `emitUpTo`). Here the fake ends right after the call, so it cost 0.5 ms. A model that sends a tool call *before* its text holds the board item until the whole reply has streamed. (Inferred from the code, not measured with a real model.)

## 4. Reduction options (SpacetimeDB stays the backbone)

| # | Option | Saves (critical path, per turn) | Effort | Notes |
| --- | --- | --- | --- | --- |
| 1 | Fix the preemptive timer (F1): silence measured from the speech end | ~300 ms of LLM time hidden when STT finishes within ~400 ms | S (worker, a few lines; optionally a `speechEndAt` field in `pushAudio` or the phrase row) | biggest win available; output is still held until `ready` |
| 2 | Limit TTS look-ahead to 1–2 sentences per utterance, and schedule sentence 0 first | 0 single-session; ~400–700 ms p95 with 3–4 parallel sessions | S–M (`addSentence` inserts the next `tts_job` when one finishes or on `markPlayed`) | playback only needs the next sentence (each is ~3.5 s long) |
| 3 | `withConfirmedReads(false)` in the client and the worker | ~11–20 ms (≥ 3 hops × 5.5 ms), reducer RTT 8 → 2.5 ms | XS (2 builder calls) | a server crash can then show rows that are lost: acceptable for this app. Measured: p50 7.7 → 2.1 ms per hop |
| 4 | `PLAYBACK_LEAD_MS` 40 → 10 | ~30 ms | XS (config) | the scheduling path is ~3 ms; keep 10 ms as safety |
| 5 | Streaming TTS for the first sentence: split it into ~1 s audio blocks inserted as `audio_out` sub-chunks (`idx`, `part`). Inside a procedure only one HTTP response is possible, so either the worker streams Cartesia's websocket and inserts blocks via a reducer, or the module asks for the first clause separately | 150–400 ms (first byte instead of full sentence) | M–L | keeps SpacetimeDB as the only audio path; playback queue already handles blocks |
| 6 | Drop the `withTx` pre-check in `synthesizeSentence` (check `pending` only at insert, which it already does) | ~8 ms | XS | costs a wasted TTS call only if the sentence was dropped in the ~ms between |
| 7 | Prefetch context: call `buildContext` when the turn becomes `closing` (or after each transcript) and reuse it if nothing changed | ~9 ms | S | |
| 8 | Chunker: confirm a boundary at `.`/`!`/`?` at end of a token when the preceding word is not an abbreviation/number, instead of waiting for the next token | 1 inter-token gap (10–40 ms) | S | keep the look-ahead only for `.` after digits/titles |
| 9 | Emit a tool call as soon as its argument JSON parses (or when text content starts), not at the next index/stream end (F6) | 0 here; up to the whole stream length when tools come first | S | |
| 10 | Downlink audio as µ-law (8-bit) or Opus | locally ~2–5 ms; on the internet 165 KB → 83 KB (µ-law) or ~10 KB (Opus) per sentence | µ-law S (encode in the procedure, decode in the client); Opus M (WebCodecs decode) | gzip saves only 2.5 % on PCM; `withCompression('none')` would remove the gzip CPU on both ends |
| 11 | Uplink µ-law / Opus, chunk size | ~0 locally (one-way is 1.2 ms; the final chunk leaves at phrase end) | S / M | only matters on a remote server: 32 KB/s → 16 KB/s / ~3 KB/s. Chunk size has no latency effect; 45 B overhead per chunk |
| 12 | VAD silence windows: `VAD_PHRASE_MS` 300 → 288 (9 frames) and `VAD_TURN_MS` 700 → 672 to remove the quantisation; or a turn-detection model | 4–30 ms (quantisation); 200+ ms with a smart turn detector | XS / L | the 700 ms turn wait is 47 % of a typical turn |
| 13 | Warm procedure instances after publish (one dummy scheduled procedure on `init`/connect) | 30 ms on the first turns only | XS | |

Summed, options 3, 4, 6, 7 and 8 cut the ~100 ms internal overhead to ~45 ms. Options 1, 2 and 5
attack the larger, scheduling-related waits (hundreds of ms).

## 5. What moving the server side off the laptop would change

**Internet round trips per turn in the current topology** (laptop runs SpacetimeDB and the
worker; all providers are over the hotspot):

| Call | per turn | on the critical path | payload over the hotspot |
| --- | --- | --- | --- |
| STT `POST /stt` (procedure) | 1 per phrase (1–2) | the last phrase, in 4/12 turns | 27–121 KB up |
| LLM stream (worker) | 1 per tool round (1–2) | yes: time to the first sentence | ~10 KB up, tokens down |
| TTS `POST /tts/bytes` (procedure) | 1 per sentence (4) | sentence 0 | ~165 KB down each |
| total | 6–8 HTTPS exchanges | 2–3 sequential | |

Measured hotspot path (`net-probe.sh`, n = 5 each): TCP connect 70–140 ms (≈ 1 RTT), TLS +80 ms,
tiny-request TTFB 290–430 ms (Cartesia) and 170–460 ms (OpenRouter). STT HTTP never took less
than 179 ms and did not grow with the phrase size, so it is RTT- and server-bound, not
bandwidth-bound. Whether `ctx.http.fetch` reuses connections could not be determined (no
connection-level visibility from inside the module); if it does not, every STT/TTS call pays
connect + TLS ≈ 150–220 ms extra.

**If SpacetimeDB and the worker ran in a data centre close to the providers** (RTT ~5–20 ms):

- Saved: per critical external call 1 hotspot RTT minus 1 DC RTT, ≈ 60–130 ms × 2–3 calls = **~150–350 ms per turn**, plus 150–220 ms per call if the fetch does not keep connections alive, and most of the hotspot *jitter* (TTS p95/p50 = 1.5×, STT 2.3× in these runs).
- Added: the client's own hops cross the internet. endTurn (on the turn-end path) +½ RTT ≈ 50 ms; the final chunk +½ RTT (only on the STT path); sentence 0's audio to the client +½ RTT + transfer. The transfer is the same 165 KB the laptop downloads from Cartesia today, so roughly neutral; with Opus downlink (option 10) it shrinks to ~10 KB. Reducer round trips the UI waits for (markPlayed etc.) are off the critical path.
- Net: **~100–300 ms faster per turn and far less variance**. The ~100 ms internal overhead stays about the same (the same hops, now in the data centre, plus ~1 client RTT). The procedure cap (finding F4) moves with the server: a cloud instance with more cores, or option 2, removes it.

## Appendix A: full stage table (single-session batch, `analyze.mjs` output)

See `e2e/latency/analyze.mjs` for the exact definition of each stage.

| stage | n | p50 | p95 | max | min | note |
| --- | --- | --- | --- | --- | --- | --- |
| vad.infer_first_ms | 10 | 19.3 | 20.2 | 20.2 | 18.5 |  |
| vad.infer_ms | 8024 | 1.1 | 2.4 | 7.3 | 0.3 |  |
| vad.frame_cost_ms | 8024 | 1.2 | 2.6 | 7.4 | 0.3 |  |
| vad.frame_interval_ms | 8024 | 32.0 | 37.5 | 45.2 | 18.5 |  |
| vad.speech_start_after_onset_ms | 16 | 192 | 320 | 320 | 160 | audio time from first non-silent frame to the decision frame end |
| vad.speech_start_after_first_speechy_ms | 18 | 128 | 128 | 128 | 128 | VAD_MIN_SPEECH_MS=100 quantised to 32 ms frames |
| vad.preroll_ms | 20 | 320 | 320 | 320 | 0.0 |  |
| vad.phrase_end_after_last_voiced_ms | 20 | 320 | 320 | 320 | 320 | config VAD_PHRASE_MS=300 |
| vad.turn_end_after_last_voiced_ms | 12 | 704 | 704 | 704 | 704 | config VAD_TURN_MS=700 |
| up.push_rtt_ms | 300 | 8.1 | 14.0 | 21.6 | 4.2 |  |
| up.push_oneway_ms | 320 | 1.2 | 2.3 | 3.6 | 0.3 | client call (Date.now, 1 ms res.) -> reducer tx timestamp |
| up.push_bytes | 300 | 5120 | 10240 | 25600 | 4096 |  |
| up.push_final_rtt_ms | 20 | 8.5 | 10.1 | 13.5 | 5.2 |  |
| up.push_final_bytes | 20 | 3072 | 4096 | 4096 | 0.0 |  |
| up.ws_overhead_bytes | 320 | 45.0 | 45.0 | 76.0 | 45.0 | websocket payload bytes minus raw PCM bytes (BSATN envelope) |
| up.final_chunk_commit_after_phrase_end_ms | 20 | 0.6 | 1.4 | 1.6 | 0.3 |  |
| up.endturn_oneway_ms | 12 | 0.7 | 1.7 | 1.7 | 0.3 |  |
| up.endturn_to_closing_visible_ms | 4 | 5.3 | 8.3 | 8.3 | 4.3 |  |
| up.reducer_rtt_endTurn_ms | 12 | 8.0 | 10.0 | 10.0 | 4.0 |  |
| up.reducer_rtt_reportNoise_ms | 12 | 12.0 | 16.0 | 16.0 | 8.0 |  |
| up.reducer_rtt_markPlayed_ms | 44 | 8.0 | 17.0 | 22.0 | 4.0 |  |
| sched.stt_due_to_start_ms | 20 | 3.0 | 4.8 | 5.4 | 1.7 |  |
| proc.stt_read_tx_ms | 20 | 7.8 | 11.1 | 17.7 | 3.9 | withTx: find phrase + join audio_in chunks |
| proc.stt_before_http_ms | 20 | 8.5 | 11.1 | 17.7 | 3.9 | entry -> HTTP start (read tx + concat + multipart) |
| ext.stt_http_ms | 20 | 292 | 671 | 748 | 196 |  |
| proc.stt_after_http_ms | 20 | 7.0 | 10.0 | 10.0 | 4.0 | JSON parse + finishPhrase withTx commit |
| proc.stt_phrase_bytes | 20 | 90112 | 120832 | 120832 | 26624 |  |
| sched.tts_due_to_start_ms | 48 | 2.7 | 3.7 | 4.4 | 1.5 |  |
| proc.tts_read_tx_ms | 48 | 7.7 | 12.2 | 22.6 | 4.3 | withTx: sentence still pending? |
| proc.tts_before_http_ms | 48 | 7.7 | 13.0 | 22.6 | 4.3 |  |
| ext.tts_http_ms | 48 | 532 | 805 | 851 | 416 |  |
| proc.tts_body_ms | 48 | 0.0 | 1.0 | 1.0 | 0.0 | res.bytes() |
| proc.tts_after_http_to_insert_ms | 48 | 1.0 | 2.0 | 2.0 | 0.0 |  |
| proc.tts_commit_ms | 48 | 5.0 | 8.0 | 12.0 | 4.0 | audio_out + reply_sentence + session commit |
| down.audio_pcm_bytes | 48 | 168960 | 211200 | 218880 | 153600 |  |
| sched.tts_parallel_http_per_utterance | 12 | 3.0 | 4.0 | 4.0 | 3.0 | max overlapping TTS HTTP calls of one utterance |
| proc.buildContext_ms | 12 | 6.7 | 9.7 | 9.7 | 4.4 |  |
| down.audio_insert_to_client_ms | 48 | 15.6 | 21.5 | 27.3 | 10.5 | tts.insert log (in tx) -> client onInsert; includes commit + fan-out + ws + decode |
| down.audio_commit_to_client_ms | 48 | 9.2 | 14.2 | 15.3 | 5.5 | after procedure commit -> client onInsert |
| down.sentence_row_ms | 48 | 7.0 | 14.6 | 16.6 | 3.4 | addSentence tx -> client onInsert |
| render.caption_after_play_start_ms | 44 | 3.9 | 6.3 | 7.2 | 1.8 | play_start timer -> caption in DOM (session tab) |
| down.observer_caption_after_play_start_ms | 8 | 10.8 | 23.9 | 23.9 | 9.3 | session play_start -> markPlayed -> observer DOM (fan-out to a 2nd client) |
| render.phrase_text_ms | 20 | 8.6 | 19.6 | 21.1 | 2.6 | phrase row (transcript) -> caption in DOM |
| down.phrase_text_row_ms | 20 | 7.4 | 10.8 | 11.1 | 4.3 | finishPhrase tx -> client onUpdate |
| down.board_row_ms | 12 | 8.3 | 25.1 | 25.1 | 5.5 |  |
| render.board_ms | 12 | 8.1 | 17.1 | 17.1 | 2.3 | onInsert -> board item in DOM |
| down.turn_ready_row_ms | 12 | 6.5 | 10.8 | 10.8 | 4.3 |  |
| down.ws_audio_frame_bytes | 48 | 164768 | 203960 | 210068 | 145787 |  |
| w.turn_ready_seen_ms | 12 | 5.5 | 10.8 | 10.8 | 3.7 | turnReady tx -> worker onUpdate |
| w.seen_to_run_start_ms | 12 | 0.3 | 4.1 | 4.1 | 0.1 |  |
| w.buildContext_rtt_ms | 12 | 9.1 | 14.6 | 14.6 | 5.7 | procedure call -> result (incl. image when first) |
| w.buildContext_call_hop_ms | 12 | 1.3 | 7.1 | 7.1 | 0.7 |  |
| w.prompt_build_ms | 12 | 0.1 | 0.2 | 0.2 | 0.0 |  |
| w.llm_sdk_to_server_ms | 12 | 2.5 | 3.8 | 3.8 | 0.9 | llm.stream() -> first request byte at the local fake LLM |
| w.llm_prompt_bytes | 12 | 9594 | 10031 | 10031 | 9587 |  |
| w.chunker_lookahead_ms | 36 | 14.2 | 17.5 | 19.4 | 12.4 | sentence-final token -> chunk emitted (needs the next token) |
| w.addSentence_rtt_ms | 48 | 7.4 | 14.9 | 16.7 | 3.7 |  |
| w.addSentence_oneway_ms | 48 | 1.3 | 1.8 | 2.0 | 0.6 |  |
| w.first_sentence_outbox_wait_ms | 12 | 0.1 | 0.7 | 0.7 | 0.1 | chunk emitted -> addSentence sent (ordered outbox; idx 0 waits for beginUtterance) |
| w.sentence_outbox_wait_ms | 24 | 0.1 | 0.1 | 0.2 | 0.0 | chunk emitted -> addSentence sent (ordered outbox; idx 0 waits for beginUtterance) |
| w.beginUtterance_rtt_ms | 12 | 7.0 | 10.9 | 10.9 | 5.3 |  |
| w.tool_args_done_to_event_ms | 12 | 0.5 | 4.9 | 4.9 | -0.1 | last argument delta sent by the LLM -> tool_call event in the worker |
| w.tool_outbox_wait_ms | 12 | 6.3 | 10.4 | 10.4 | 3.9 |  |
| w.tool_reducer_rtt_ms | 12 | 8.8 | 15.4 | 15.4 | 5.8 |  |
| w.tool_event_to_board_dom_ms | 12 | 27.1 | 39.7 | 39.7 | 21.2 |  |
| play.receive_to_scheduled_ms | 48 | 2.0 | 10.3 | 61.6 | 0.4 | onInsert -> buffer scheduled (in-order blocks) |
| play.prep_ms | 48 | 0.8 | 3.5 | 4.3 | 0.3 | PCM16 -> float, trim, fades, AudioBuffer |
| play.lead_ms | 12 | 40.0 | 40.0 | 40.0 | 40.0 | scheduled -> start (PLAYBACK_LEAD_MS) |
| play.output_latency_ms | 48 | 39.0 | 39.0 | 39.0 | 33.0 |  |
| play.extra_gap_ms | 36 | -0.0 | -0.0 | -0.0 | -0.0 | gap beyond SENTENCE_PAUSE_MS (late audio) |
| e2e.speech_end_to_first_audio_ms | 12 | 1429 | 2104 | 2104 | 1374 |  |
| e2e.turn_end_to_first_audio_ms | 12 | 724 | 1398 | 1398 | 663 |  |
| e2e.turn_ready_to_first_audio_ms | 12 | 699 | 1060 | 1060 | 663 |  |
| up.reducer_rtt_interrupt_ms | 2 | 10.0 | 10.0 | 10.0 | 10.0 |  |
| play.barge_in_to_flush_ms | 2 | 0.3 | 0.3 | 0.3 | 0.3 |  |
| up.barge_in_to_interrupt_reducer_ms | 2 | 1.5 | 1.6 | 1.6 | 1.5 |  |
| vad.barge_in_after_onset_ms | 2 | 960 | 960 | 960 | 960 | BARGE_IN_MIN_MS=400 + onset lag |
| sched.global_parallel_http | 1 | 4.0 | 4.0 | 4.0 | 4.0 | max overlapping STT+TTS HTTP calls across all sessions of the batch |
| sched.global_parallel_http_sessions | 1 | 1.0 | 1.0 | 1.0 | 1.0 | sessions involved in that overlap |

## Appendix B: files

- `spacetimedb/src/lat.ts`, `worker/src/lat.ts`: temporary `LAT` loggers (branch only; remove before merging anything).
- `client/src/audio/{AudioCapture,VoiceSession,PlaybackQueue}.ts`: temporary per-frame, per-chunk and scheduling instrumentation.
- `worker/src/main.ts`: `LLM_BASE_URL` override (branch only).
- `e2e/latency/`: `fake-llm.mjs`, `run.mjs`, `batch.sh`, `parallel.sh`, `bench-reducers.ts`, `net-probe.sh`, `fetch-logs.sh`, `analyze.mjs`.
