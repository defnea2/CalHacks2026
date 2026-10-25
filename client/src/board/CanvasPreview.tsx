import { useMemo, useState } from 'react';
import { Board, type BoardItemView } from './Board';
import { utteranceProgress } from './reveal';
import type { VoiceCanvasContent } from '../../../src/presentation/voice/contracts';

const examples: { title: string; speech: string[]; content: VoiceCanvasContent }[] = [
  { title: 'Slant, cut, slide', speech: [
    'This slanted shape is six units across and four units high.',
    'Cut the triangle along the dotted height line.',
    'Slide that same triangle across to make a rectangle.',
    'No pieces grew or disappeared, so the area is still six times four.',
  ], content: { title: 'Does slanting change the area?', moments: [
    { sentenceOffset: 0, visual: { kind: 'parallelogram', base: 6, height: 4, shear: 2, stage: 'slant' } },
    { sentenceOffset: 1, visual: { kind: 'update', changes: [{ type: 'set_parallelogram', stage: 'cut' }] } },
    { sentenceOffset: 2, visual: { kind: 'update', changes: [{ type: 'set_parallelogram', stage: 'reassembled' }] } },
    { sentenceOffset: 3, visual: { kind: 'keep' }, showEquation: true },
  ] } },
  { title: 'Split a multiplication', speech: [
    'There are four rows, with eight squares in each row.',
    'Split each row into five and three squares without adding any squares.',
    'Twenty plus twelve is still thirty-two; try a different split.',
  ], content: { title: 'One rectangle, two parts', moments: [
    { sentenceOffset: 0, visual: { kind: 'array', rows: 4, columns: 8 } },
    { sentenceOffset: 1, visual: { kind: 'update', changes: [{ type: 'set_array', splitAt: 5 }] } },
    { sentenceOffset: 2, visual: { kind: 'keep' }, showEquation: true, interactive: true },
  ] } },
  { title: 'Stretch a rectangle', speech: [
    'This rectangle is three squares wide and two squares tall.',
    'Double its width so each of the two rows gains three squares.',
    'The area doubles from six to twelve; change the width and compare.',
  ], content: { title: 'What changes when it gets wider?', moments: [
    { sentenceOffset: 0, visual: { kind: 'geometry', shape: 'rectangle', width: 3, height: 2 } },
    { sentenceOffset: 1, visual: { kind: 'update', changes: [{ type: 'set_geometry', width: 6 }] } },
    { sentenceOffset: 2, visual: { kind: 'keep' }, showEquation: true, interactive: true },
  ] } },
  { title: 'Equal fractions', speech: [
    'One half of the bar is shaded.',
    'Divide each half into two while keeping the shaded length the same.',
    'One half and two quarters cover the same length; try changing the bars.',
  ], content: { title: 'New pieces, same amount', moments: [
    { sentenceOffset: 0, visual: { kind: 'bars', bars: [{ id: 'a', label: 'One half', parts: 2, shaded: 1 }] } },
    { sentenceOffset: 1, visual: { kind: 'update', changes: [{ type: 'set_bar', barId: 'a', parts: 4, shaded: 2 }] } },
    { sentenceOffset: 2, visual: { kind: 'bars', bars: [
      { id: 'a', label: 'Two quarters', parts: 4, shaded: 2 }, { id: 'b', label: 'One half', parts: 2, shaded: 1 },
    ] }, showEquation: true, interactive: true },
  ] } },
];

/** Uses the production board adapter with explicit sentence events, without a DB or microphone. */
export function CanvasPreview() {
  const [example, setExample] = useState(0);
  const [run, setRun] = useState(0);
  const [sentence, setSentence] = useState(-1);
  const [interrupted, setInterrupted] = useState(false);
  const [ended, setEnded] = useState(false);
  const current = examples[example]!;
  const u = BigInt(run + 1);
  const items: BoardItemView[] = useMemo(() => [{ id: 1n, idx: 0, kind: 'math_canvas',
    content: JSON.stringify(current.content), visible: true, utteranceId: u, sentenceIdx: 0, markerPos: -1,
    answerState: '', lastAnswer: '',
  }], [current, u]);
  const started = Array.from({ length: sentence + 1 }, (_, i) => i);
  const serverOver = () => ended || interrupted;
  const progress = utteranceProgress([], new Map([[u.toString(), started]]), serverOver, ['played'], ['played', 'dropped']);
  const reset = () => { setSentence(-1); setInterrupted(false); setEnded(false); setRun(n => n + 1); };
  return <main className="mx-auto flex max-w-4xl flex-col gap-6 p-6">
    <header className="flex flex-wrap items-center justify-between gap-4">
      <div><p className="text-sm text-muted-foreground">Canvas integration test · no microphone needed</p>
      <h1 className="text-2xl font-semibold">Follow the explanation</h1></div>
      <a href="/" className="text-sm underline">Voice sessions</a>
    </header>
    <p className="text-sm text-muted-foreground">Each click sends the same sentence-start event used by audio playback. These are test examples; arbitrary questions are available in the text tutor.</p>
    <div className="flex flex-wrap gap-2">{examples.map((e, index) => <button key={e.title}
      className="rounded-lg border px-3 py-2 text-sm" aria-pressed={example === index}
      onClick={() => { setExample(index); reset(); }}>{e.title}</button>)}</div>
    <p className="min-h-14 text-lg" aria-live="polite">{sentence < 0 ? 'Start the first sentence to reveal the picture.' : current.speech[sentence]}</p>
    <Board key={run} items={items} progress={progress} serverOver={serverOver} allowCanvasInteraction={ended && !interrupted} />
    <div className="flex flex-wrap items-center gap-3">
      <button className="rounded-lg bg-primary px-4 py-2 text-primary-foreground" disabled={interrupted || ended}
        onClick={() => sentence < current.speech.length - 1 ? setSentence(n => n + 1) : setEnded(true)}>
        {sentence < 0 ? 'Start explanation' : sentence < current.speech.length - 1 ? 'Next sentence' : 'Finish speech · your turn'}
      </button>
      <button className="rounded-lg border px-4 py-2" onClick={() => setInterrupted(true)} disabled={sentence < 0 || ended || interrupted}>Interrupt</button>
      <button className="rounded-lg border px-4 py-2" onClick={reset}>Replay</button>
      <span className="text-sm text-muted-foreground">{interrupted ? 'Interrupted — later pictures stay hidden' : ended ? 'Your turn — change the picture' : `${sentence + 1} / ${current.speech.length} sentences`}</span>
    </div>
    <details className="text-sm"><summary>Canvas command</summary><pre className="mt-3 overflow-auto rounded-lg bg-muted p-4">{JSON.stringify(current.content, null, 2)}</pre></details>
  </main>;
}
