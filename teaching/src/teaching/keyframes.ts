// Per-sentence keyframes inside one streamed moment. A moment is one visual change + 1-3 spoken
// sentences, and its beat shows when its FIRST sentence starts playing. A formalization moment
// changes two things: the picture, then its equation. The equation should land on the sentence
// that reads it out, not with the picture. splitKeyframes moves the equation reveal into its own
// cue whose id carries the sentence offset (`<cue>-s<k>`); clients reveal that cue when sentence
// `beat.sentenceIdx + k` starts (client/src/lesson/beatPlayer.ts). The end state is unchanged.
import type { VisualBeat } from "../presentation/contracts";

type Cue = VisualBeat["cues"][number];
type Command = Cue["commands"][number];

const SUFFIX = /-s(\d+)$/;
/** Sentence offset of a cue inside its beat (0 = with the beat's first sentence). */
export function cueSentenceOffset(cueId: string): number {
  const m = SUFFIX.exec(cueId);
  return m ? Number(m[1]) : 0;
}

/** A sentence that reads an equation out (numbers, operators, "equals"). */
const EQUATION_WORDS = /\d|=|\b(equals?|times|over|plus|minus|divided|is the same as|makes|rule)\b/i;

/** Index (>= 1) of the sentence that should reveal the equation, or -1 when it belongs to the
 *  beat's first sentence (one sentence, or the first one already reads the equation out). */
export function equationSentence(sentences: readonly string[]): number {
  if (sentences.length < 2 || EQUATION_WORDS.test(sentences[0]!)) return -1;
  for (let k = 1; k < sentences.length; k++) if (EQUATION_WORDS.test(sentences[k]!)) return k;
  return sentences.length - 1;
}

const isEquationOn = (c: Command) =>
  c.type === "update_math" && (c as { change?: { type?: string; visible?: boolean } }).change?.type === "set_equation" && (c as { change: { visible?: boolean } }).change.visible === true;

/**
 * Splits the equation reveal of a single-cue beat onto the sentence that reads it. `msPerWord`
 * estimates the cue's atMs (the team director's own timing, used by the lab without audio).
 */
export function splitKeyframes(beat: VisualBeat, sentences: readonly string[], msPerWord = 380): VisualBeat {
  if (beat.cues.length !== 1) return beat;
  const k = equationSentence(sentences);
  if (k < 1) return beat;
  const cue = beat.cues[0]!;
  const reveal: Command[] = [];
  const rest: Command[] = [];
  for (const c of cue.commands) {
    if (isEquationOn(c)) reveal.push(c);
    else if (c.type === "show_math" && (c as { visual: { showEquation?: boolean } }).visual.showEquation) {
      const visual = (c as { visual: { id: string; showEquation: boolean } }).visual;
      rest.push({ ...c, visual: { ...visual, showEquation: false } } as Command);
      reveal.push({ type: "update_math", id: visual.id, change: { type: "set_equation", visible: true } } as Command);
    } else rest.push(c);
  }
  if (!reveal.length || !rest.length) return beat;
  const words = sentences.slice(0, k).join(" ").split(/\s+/).filter(Boolean).length;
  return { ...beat, cues: [{ ...cue, commands: rest }, { id: `${cue.id}-s${k}`, atMs: Math.min(180000, Math.max(cue.atMs, words * msPerWord)), commands: reveal }] };
}
