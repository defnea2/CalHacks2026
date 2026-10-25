import type { Transport } from '../transport';

/** What a tool handler may use. */
export interface ToolContext {
  sessionId: bigint;
  /** Utterance the current reply belongs to. */
  utteranceId: bigint;
  /** Index the next sentence added to this utterance will get (board reveal sync). */
  nextSentenceIdx: number;
  /** Reveal anchor of the inline marker ⟦id⟧ in this reply's speech (consumed), if any. */
  anchor?: (id: unknown) => { sentenceIdx: number; pos: number } | undefined;
  transport: Transport;
  /** Publishes one audio cue per line inside the current ordered operation. One plan per reply. */
  narrate?: (lines: string[]) => Promise<void>;
}

/** An object result means the tool is complete: no follow-up LLM round for it (the router
 *  reports it as an action). */
export interface NarratedToolOutput {
  text: string;
  /** This tool already delivered the reply's speech (self-narrated canvas). */
  narrated?: boolean;
}

/** One tool module: everything except name/description/parameters, which come from the pack
 *  (buildToolSpecs). `action` tools run and report ok/error; `query` tools return data the
 *  LLM needs, so the LLM is called again with the result. */
export interface ToolModule {
  name: string;
  kind: 'action' | 'query';
  timeoutMs?: number;
  /** Returns the tool result text. Throwing is fine: the router turns it into an error result. */
  handler(args: Record<string, unknown>, ctx: ToolContext): Promise<string | NarratedToolOutput>;
}

export interface ToolDef extends ToolModule {
  description: string;
  parameters: Record<string, unknown>;
}

export const str = (v: unknown): string => (typeof v === 'string' ? v : v === undefined || v === null ? '' : String(v));
