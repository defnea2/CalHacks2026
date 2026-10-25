// Board renderer contract. Part of the replaceable lesson-pack boundary (spec
// "Replaceable lesson pack"): kind names appear only inside client/src/board/.
import type { ComponentType } from 'react';

export interface RevealState {
  /** The item's tagged sentence has started playing (or it was untagged). */
  revealed: boolean;
  /** Sentences of the same utterance started since the tagged one, inclusive (1 = just revealed).
   *  Infinity when the utterance is over or the item was untagged. Used to step through content. */
  progress: number;
}

/** Item state for interactive kinds (gap tasks). `submit` is absent in read-only views. */
export interface AnswerProps {
  state: string;
  last: string;
  submit?: (answer: string) => Promise<void> | void;
}

export interface RendererProps<C = Record<string, unknown>> {
  content: C;
  reveal: RevealState;
  answer: AnswerProps;
}

export type BoardRenderer = ComponentType<RendererProps<any>>;
