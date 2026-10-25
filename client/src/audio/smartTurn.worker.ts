// Smart Turn inference off the main thread. Feature extraction (~25-60 ms) plus one wasm run
// (~200 ms single-threaded) would otherwise stall the main thread, where vad-web runs Silero on
// every 32 ms frame and the playback queue schedules audio. Same onnxruntime-web package and the
// same wasm files (served under /vad/) as the Silero VAD; a worker cannot share the instance.
import * as ort from 'onnxruntime-web/wasm';
import { N_FRAMES, N_MELS, smartTurnFeatures } from './smartTurnFeatures';

export type SmartTurnRequest =
  | { type: 'init'; modelUrl: string; wasmPaths: string }
  | { type: 'predict'; id: number; pcm: Float32Array };

export type SmartTurnReply =
  | { type: 'ready'; loadMs: number; fetchMs: number; bytes: number }
  | { type: 'result'; id: number; prob: number; featMs: number; inferMs: number }
  | { type: 'skipped'; id: number }
  | { type: 'error'; id?: number; error: string };

let session: ort.InferenceSession | null = null;
let ready: Promise<void> | null = null;
// one inference at a time; a request still waiting when a newer one arrives is skipped
// (the state machine only cares about the latest phrase end)
let next: { id: number; pcm: Float32Array } | null = null;
let busy = false;

const post = (m: SmartTurnReply) => (self as unknown as Worker).postMessage(m);

async function init(modelUrl: string, wasmPaths: string): Promise<void> {
  ort.env.logLevel = 'error';
  ort.env.wasm.numThreads = 1;
  ort.env.wasm.wasmPaths = wasmPaths;
  const t0 = performance.now();
  const res = await fetch(modelUrl);
  if (!res.ok) throw new Error(`model ${res.status}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  const t1 = performance.now();
  session = await ort.InferenceSession.create(bytes, { executionProviders: ['wasm'], graphOptimizationLevel: 'all' });
  // warm-up run: the first call pays for kernel setup
  await session.run({ input_features: new ort.Tensor('float32', new Float32Array(N_MELS * N_FRAMES), [1, N_MELS, N_FRAMES]) });
  post({ type: 'ready', loadMs: Math.round(performance.now() - t0), fetchMs: Math.round(t1 - t0), bytes: bytes.length });
}

async function predict(id: number, pcm: Float32Array): Promise<void> {
  await ready;
  if (!session) throw new Error('no session');
  const t0 = performance.now();
  const feats = smartTurnFeatures(pcm);
  const t1 = performance.now();
  const out = await session.run({ input_features: new ort.Tensor('float32', feats, [1, N_MELS, N_FRAMES]) });
  const t2 = performance.now();
  const prob = Number((out[session.outputNames[0]!]!.data as Float32Array)[0]);
  post({ type: 'result', id, prob, featMs: t1 - t0, inferMs: t2 - t1 });
}

self.onmessage = (ev: MessageEvent<SmartTurnRequest>) => {
  const m = ev.data;
  if (m.type === 'init') {
    ready = init(m.modelUrl, m.wasmPaths).catch(err => {
      post({ type: 'error', error: String(err) });
      throw err;
    });
    ready.catch(() => {});
    return;
  }
  if (next) post({ type: 'skipped', id: next.id });
  next = { id: m.id, pcm: m.pcm };
  void drain();
};

async function drain(): Promise<void> {
  if (busy) return;
  busy = true;
  while (next) {
    const r = next;
    next = null;
    await predict(r.id, r.pcm).catch(err => post({ type: 'error', id: r.id, error: String(err) }));
  }
  busy = false;
}
