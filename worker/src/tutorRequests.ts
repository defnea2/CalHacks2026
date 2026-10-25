// tutor_request rows (replaces the Vite endpoint /api/teaching/shear-feedback): the client inserts a
// request through the requestTutor reducer, the worker runs the team's slant-lesson tutor (Anthropic,
// non-streaming, 30 s) and answers with submitTutorResult. At most 4 at a time, each row once.
import { createShearTutor } from '../../src/server/shearTutor';
import type { Transport } from './transport';

export interface TutorRequestRow {
  id: bigint;
  sessionId: bigint;
  kind: string;
  payload: string;
  status: string;
}

export type TutorHandler = (payload: unknown, signal: AbortSignal) => Promise<unknown>;

export class TutorRequests {
  private readonly seen = new Set<bigint>();
  private active = 0;
  private readonly queue: TutorRequestRow[] = [];

  constructor(
    private readonly transport: Pick<Transport, 'submitTutorResult'>,
    private readonly handlers: Record<string, TutorHandler>,
    private readonly log: (m: string) => void,
    private readonly opts = { max: 4, timeoutMs: 30_000 }
  ) {}

  static anthropic(transport: Pick<Transport, 'submitTutorResult'>, apiKey: string, model: string, log: (m: string) => void) {
    return new TutorRequests(transport, { shear_feedback: createShearTutor({ apiKey, model, effort: 'low' }) }, log);
  }

  onRequest(row: TutorRequestRow): void {
    if (row.status !== 'pending' || this.seen.has(row.id)) return;
    this.seen.add(row.id);
    this.queue.push(row);
    this.pump();
  }

  private pump(): void {
    while (this.active < this.opts.max && this.queue.length) void this.run(this.queue.shift()!);
  }

  private async run(row: TutorRequestRow): Promise<void> {
    this.active++;
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(new Error('Tutor reply timed out.')), this.opts.timeoutMs);
    let ok = false;
    let result: string;
    try {
      const handler = this.handlers[row.kind];
      if (!handler) throw new Error(`unsupported tutor request ${row.kind}`);
      result = JSON.stringify(await handler(JSON.parse(row.payload), abort.signal));
      ok = true;
    } catch (e) {
      result = abort.signal.aborted ? 'Tutor reply timed out.' : e instanceof Error ? e.message : String(e);
    } finally {
      clearTimeout(timer);
    }
    try {
      await this.transport.submitTutorResult({ requestId: row.id, ok, result });
      this.log(`[tutor] request ${row.id} (${row.kind}) ${ok ? 'answered' : `failed: ${result}`}`);
    } catch (e) {
      this.log(`[tutor] submitTutorResult ${row.id} failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    this.active--;
    this.pump();
  }
}
