// Main-thread handle for the Smart Turn worker (smartTurn.worker.ts).
import type { SmartTurnReply, SmartTurnRequest } from './smartTurn.worker';

export const SMART_TURN_MODEL_FILE = 'smart-turn-v3.2-cpu.onnx';

export interface SmartTurnVerdict {
  prob: number;
  featMs: number;
  inferMs: number;
}

export class SmartTurnDetector {
  private readonly worker: Worker;
  private readonly waiting = new Map<number, (v: SmartTurnVerdict | null) => void>();
  readonly ready: Promise<{ loadMs: number; fetchMs: number; bytes: number }>;

  constructor(assetPath: string) {
    this.worker = new Worker(new URL('./smartTurn.worker.ts', import.meta.url), { type: 'module' });
    let resolveReady!: (v: { loadMs: number; fetchMs: number; bytes: number }) => void;
    let rejectReady!: (e: Error) => void;
    this.ready = new Promise((res, rej) => {
      resolveReady = res;
      rejectReady = rej;
    });
    this.ready.catch(() => {});
    this.worker.onmessage = (ev: MessageEvent<SmartTurnReply>) => {
      const m = ev.data;
      if (m.type === 'ready') resolveReady(m);
      else if (m.type === 'result') this.settle(m.id, { prob: m.prob, featMs: m.featMs, inferMs: m.inferMs });
      else if (m.type === 'skipped') this.settle(m.id, null);
      else if (m.id !== undefined) this.settle(m.id, null);
      else rejectReady(new Error(m.error));
    };
    this.worker.onerror = ev => rejectReady(new Error(ev.message || 'worker error'));
    const abs = new URL(assetPath, location.href).href;
    this.send({ type: 'init', modelUrl: abs + SMART_TURN_MODEL_FILE, wasmPaths: abs });
  }

  /** P(turn complete) for the turn audio (16 kHz mono), or null if skipped / failed. */
  predict(id: number, pcm: Float32Array): Promise<SmartTurnVerdict | null> {
    return new Promise(resolve => {
      this.waiting.set(id, resolve);
      this.send({ type: 'predict', id, pcm }, [pcm.buffer]);
    });
  }

  destroy(): void {
    this.worker.terminate();
    for (const r of this.waiting.values()) r(null);
    this.waiting.clear();
  }

  private settle(id: number, v: SmartTurnVerdict | null): void {
    const r = this.waiting.get(id);
    this.waiting.delete(id);
    r?.(v);
  }

  private send(m: SmartTurnRequest, transfer: Transferable[] = []): void {
    this.worker.postMessage(m, transfer);
  }
}
