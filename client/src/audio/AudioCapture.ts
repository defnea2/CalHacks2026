// AudioCapture + Vad (spec "Pipeline components"): microphone -> Silero VAD (vad-web, ONNX
// Runtime Web, 16 kHz) -> VadMachine (our phrase/turn logic) -> VadEvents.
// The library is used only for frames and speech probabilities (onFrameProcessed); its own
// segmenting is disabled, so VAD_PHRASE_MS / VAD_TURN_MS / pre-roll / min speech / max phrase
// are all ours. Model, worklet and ORT wasm are served from /vad/ (copied at dev/build time).
import { MicVAD } from '@ricky0123/vad-web';
import type { AppSettings } from '../config';
import { VadMachine, type VadEvent } from './vadMachine';
import { rmsDbfs } from './pcm';
import { eventLog } from '../lib/debug';

export interface CaptureOptions {
  ctx: AudioContext;
  settings: AppSettings;
  firstPhraseId: number;
  onEvent: (e: VadEvent) => void;
  /** Called with the latest frame level and probability (UI meter), throttled by the caller. */
  onFrame?: (levelDb: number, prob: number) => void;
}

export const VAD_ASSET_PATH = `${import.meta.env.BASE_URL ?? '/'}vad/`;

export class AudioCapture {
  readonly machine: VadMachine;
  private vad: MicVAD | null = null;
  private stream: MediaStream | null = null;
  private stopped = false;

  constructor(private readonly opts: CaptureOptions) {
    const { voice, client } = opts.settings;
    this.machine = new VadMachine({ ...voice, ...client }, { firstPhraseId: opts.firstPhraseId });
  }

  async start(): Promise<void> {
    const { ctx, settings } = this.opts;
    eventLog.log('capture.starting', { assets: VAD_ASSET_PATH, model: settings.client.VAD_MODEL });
    this.vad = await MicVAD.new({
      model: settings.client.VAD_MODEL,
      audioContext: ctx,
      baseAssetPath: VAD_ASSET_PATH,
      onnxWASMBasePath: VAD_ASSET_PATH,
      startOnLoad: false,
      // The library's own segmenting is never used; keep its thresholds out of the way.
      positiveSpeechThreshold: 0.999,
      negativeSpeechThreshold: 0.998,
      redemptionMs: 1000, // keeps the library's internal segment buffer bounded
      minSpeechMs: 0,
      preSpeechPadMs: 0,
      ortConfig: ort => {
        ort.env.logLevel = 'error';
        ort.env.wasm.numThreads = 1;
      },
      getStream: async () => {
        this.stream = await navigator.mediaDevices.getUserMedia({
          audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        });
        const track = this.stream.getAudioTracks()[0];
        eventLog.log('capture.mic', { label: track?.label ?? '', settings: track?.getSettings?.() ?? {} });
        return this.stream;
      },
      onFrameProcessed: (probs, frame) => this.onFrame(probs.isSpeech, frame),
    });
    // TEMPORARY latency instrumentation: per-frame arrival (worklet -> main thread), Silero
    // inference time and context time, in window.__lat.frames (ring of 4000 frames ≈ 128 s).
    {
      const vad = this.vad as unknown as {
        processFrame: (f: Float32Array) => Promise<void>;
        frameProcessor: { modelProcessFunc: (f: Float32Array) => Promise<unknown> };
      };
      const L = latStore();
      const origProcess = vad.processFrame;
      vad.processFrame = async (f: Float32Array) => {
        L.cur = { i: L.n++, arrive: performance.now(), ctxT: ctx.currentTime, inferMs: 0, done: 0 };
        await origProcess(f);
      };
      const fp = vad.frameProcessor;
      const origModel = fp.modelProcessFunc;
      fp.modelProcessFunc = async (f: Float32Array) => {
        const t = performance.now();
        const r = await origModel(f);
        if (L.cur) L.cur.inferMs = performance.now() - t;
        return r;
      };
    }
    await this.vad.start();
    eventLog.log('capture.started', { baseLatency: ctx.baseLatency, sampleRate: ctx.sampleRate });
  }

  private stats = { n: 0, levelSum: 0, maxLevel: -100, maxProb: 0, since: 0 };

  private onFrame(prob: number, frame: Float32Array): void {
    if (this.stopped) return;
    const level = rmsDbfs(frame);
    // once a second: frame statistics (helps debug fake microphones in the E2E harness)
    const st = this.stats;
    const now = performance.now();
    if (st.since === 0) st.since = now;
    st.n++;
    st.levelSum += level;
    st.maxLevel = Math.max(st.maxLevel, level);
    st.maxProb = Math.max(st.maxProb, prob);
    if (now - st.since >= 1000) {
      eventLog.log('vad.frame_stats', {
        frames: st.n,
        meanDb: Math.round(st.levelSum / st.n),
        maxDb: Math.round(st.maxLevel),
        maxProb: Math.round(st.maxProb * 100) / 100,
        floorDb: this.machine.noise.floorDb === null ? null : Math.round(this.machine.noise.floorDb),
        tutorSpeaking: this.machine.tutorSpeaking,
      });
      this.stats = { n: 0, levelSum: 0, maxLevel: -100, maxProb: 0, since: now };
    }
    this.opts.onFrame?.(level, prob);
    const L = latStore();
    const cur = L.cur;
    const evs = this.machine.process(prob, frame, level);
    if (cur) {
      cur.done = performance.now();
      L.frames.push({ ...cur, prob: Math.round(prob * 1000) / 1000, lvl: Math.round(level * 10) / 10, ev: evs.map(e => e.type).join(',') });
      if (L.frames.length > 4000) L.frames.shift();
    }
    for (const e of evs) {
      if (e.type !== 'noise_state') eventLog.log('lat.vad', { kind: e.type, frame: cur?.i ?? -1, ...(e.type === 'chunk' ? { seq: e.seq, final: e.final, samples: e.pcm.length } : {}) });
      this.opts.onEvent(e);
    }
  }

  set tutorSpeaking(v: boolean) {
    this.machine.tutorSpeaking = v;
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    for (const e of this.machine.stop()) this.opts.onEvent(e);
    this.stopped = true;
    try {
      await this.vad?.destroy();
    } catch (err) {
      eventLog.log('capture.error', { error: String(err) });
    }
    this.stream?.getTracks().forEach(t => t.stop());
    eventLog.log('capture.stopped', {});
  }
}

// TEMPORARY latency instrumentation store (window.__lat).
interface LatFrame { i: number; arrive: number; ctxT: number; inferMs: number; done: number }
interface LatStore { n: number; cur: LatFrame | null; frames: Array<LatFrame & { prob: number; lvl: number; ev: string }> }
function latStore(): LatStore {
  const w = window as unknown as { __lat?: LatStore };
  if (!w.__lat) w.__lat = { n: 0, cur: null, frames: [] };
  return w.__lat;
}
