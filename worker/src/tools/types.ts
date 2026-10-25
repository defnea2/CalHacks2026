import type { Transport } from '../transport';

/** What a tool handler may use. */
export interface ToolContext {
  sessionId: bigint;
  /** Utterance the current reply belongs to. */
  utteranceId: bigint;
  /** Index the next sentence added to this utterance will get (board reveal sync). */
  nextSentenceIdx: number;
  transport: Transport;
}

/** One tool module: everything except name/description/parameters, which come from the pack
 *  (buildToolSpecs). `action` tools run and report ok/error; `query` tools return data the
 *  LLM needs, so the LLM is called again with the result. */
export interface ToolModule {
  name: string;
  kind: 'action' | 'query';
  timeoutMs?: number;
  /** Returns the tool result text. Throwing is fine: the router turns it into an error result. */
  handler(args: Record<string, unknown>, ctx: ToolContext): Promise<string>;
}

export interface ToolDef extends ToolModule {
  description: string;
  parameters: Record<string, unknown>;
}

export const str = (v: unknown): string => (typeof v === 'string' ? v : v === undefined || v === null ? '' : String(v));
