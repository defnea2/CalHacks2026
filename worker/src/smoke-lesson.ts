// Live smoke of lesson mode (team streaming planner) with the real model, no SpacetimeDB.
// `pnpm --filter worker smoke:lesson [--n 3] [--effort low,medium]`. Never prints keys.
// Per run: first token, first moment released (the latency that matters: turn end -> first beat),
// total, beats, validity, and a follow-up step on the resulting canvas (answer -> next step), using
// exactly the module's state transitions (@tutor/teaching lessonFlow) and the team parser.
import { emptyCanvas, type CanvasState } from '@tutor/teaching/presentation/contracts';
import { applyCanvasCommands } from '@tutor/teaching/presentation/canvasState';
import { ANTHROPIC_SYSTEM, plannerUserMessage } from '@tutor/teaching/server/plannerPrompt';
import { LessonStreamParser } from '@tutor/teaching/server/streamingLesson';
import type { ModelRequest } from '@tutor/teaching/server/planning';
import { acceptStep, buildModelRequest, newLessonRecord, presented, recordUtterance, respond, validatorMessage, type LessonRecord } from '@tutor/teaching/teaching/lessonFlow';
import { AnthropicProvider } from './anthropic';
import { normalizePrompt, recentCheckPrompts } from '@tutor/teaching/server/plannerPrompt';
import { loadConfig } from './env';

const cfg = loadConfig();
const arg = (name: string, d: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1]! : d;
};
const N = Number(arg('n', '2'));
const efforts = arg('effort', 'low,medium').split(',') as ('low' | 'medium' | 'high')[];
const QUESTIONS = [
  { topic: 'Equivalent fractions', q: 'Why is 2/4 the same as 1/2?' },
  { topic: 'Area of a rectangle', q: 'How do I find the area of a 4 by 3 rectangle?' },
  { topic: 'Comparing decimals', q: 'Is 0.5 bigger than 0.45?' },
  { topic: 'Multiplication as equal groups', q: 'What does 3 times 4 mean?' },
];
const ANSWERS = ['Because the pieces get smaller but the same amount is shaded.', 'twelve', 'I am not sure', 'show me another way'];

interface Result { repeatedCheck?: boolean; effort: string; label: string; ok: boolean; error?: string; repaired: boolean; firstTokenMs: number; firstBeatMs: number | null; totalMs: number; beats: number }

async function lesson(llm: AnthropicProvider, request: ModelRequest, effort: string, label: string): Promise<{ result: Result; step?: ReturnType<LessonStreamParser['finish']> }> {
  const t0 = Date.now();
  let firstToken = 0;
  let firstBeat: number | null = null;
  let repair: { output: string; error: string } | null = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const parser = new LessonStreamParser(request, ev => {
      if (ev.type === 'beat' && firstBeat === null) firstBeat = Date.now() - t0;
    });
    let output = '';
    let reason = '';
    try {
      for await (const ev of llm.stream({ messages: [{ role: 'system', content: ANTHROPIC_SYSTEM }, { role: 'user', content: plannerUserMessage(request, repair) }], tools: [], signal: new AbortController().signal })) {
        if (ev.type === 'text') {
          if (!firstToken) firstToken = Date.now() - t0;
          output += ev.delta;
          parser.push(ev.delta);
        } else if (ev.type === 'done') reason = ev.finishReason;
      }
      if (reason !== 'end_turn') throw new Error(`stop ${reason}`);
      const step = parser.finish();
      const repeatedCheck = !!step.check && recentCheckPrompts(request).some(p => normalizePrompt(p) === normalizePrompt(step.check!.prompt));
      return { result: { repeatedCheck, effort, label, ok: true, repaired: attempt > 0, firstTokenMs: firstToken, firstBeatMs: firstBeat, totalMs: Date.now() - t0, beats: step.beats.length }, step };
    } catch (e) {
      const error = validatorMessage(e);
      if (process.env.SMOKE_DUMP) console.log(`  [${label}] output (${output.length} chars): ${output.slice(0, 4000)}`);
      if (firstBeat !== null || attempt > 0) return { result: { effort, label, ok: false, error, repaired: attempt > 0, firstTokenMs: firstToken, firstBeatMs: firstBeat, totalMs: Date.now() - t0, beats: parser.released } };
      console.log(`  [${label}] repair: ${error.slice(0, 200)}`);
      repair = { output, error };
    }
  }
  throw new Error('unreachable');
}

async function main() {
  const results: Result[] = [];
  for (const effort of efforts) {
    const llm = new AnthropicProvider({ apiKey: cfg.anthropicApiKey, model: cfg.anthropicModel, effort, thinking: 'disabled', maxTokens: 4000 });
    for (let run = 0; run < N; run++) {
      for (const [qi, { topic, q }] of QUESTIONS.entries()) {
        let record: LessonRecord = recordUtterance(newLessonRecord({ sessionId: `smoke${qi}`, topic, originalQuestion: q, lessonStyle: 'mini_lesson', age: 9 }), 't0', q);
        let canvas: CanvasState = emptyCanvas();
        const first = await lesson(llm, buildModelRequest(record, canvas, `r${run}q${qi}a`), effort, `${topic} / opening`).catch(e => ({ result: { effort, label: topic, ok: false, error: String(e), repaired: false, firstTokenMs: 0, firstBeatMs: null, totalMs: 0, beats: 0 } as Result, step: undefined }));
        results.push(first.result);
        log(first.result);
        if (!first.step) continue;
        record = presented(acceptStep(record, first.step, record.evidence));
        for (const beat of first.step.beats) for (const cue of beat.cues) canvas = applyCanvasCommands(canvas, cue.commands);
        const answer = ANSWERS[(qi + run) % ANSWERS.length]!;
        record = answer === 'show me another way'
          ? respond(record, 'e1', { kind: 'help', request: 'another_way' }, canvas).record
          : respond(record, 'e1', { kind: 'answer', text: answer }, canvas).record;
        const next = await lesson(llm, buildModelRequest(record, canvas, `r${run}q${qi}b`), effort, `${topic} / follow-up "${answer}"`).catch(e => ({ result: { effort, label: topic, ok: false, error: String(e), repaired: false, firstTokenMs: 0, firstBeatMs: null, totalMs: 0, beats: 0 } as Result }));
        results.push(next.result);
        log(next.result);
      }
    }
  }
  console.log('\n=== summary ===');
  for (const effort of efforts) {
    const r = results.filter(x => x.effort === effort);
    const p = (xs: number[], q: number) => (xs.length ? xs.sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(q * xs.length))]! : NaN);
    const fb = r.map(x => x.firstBeatMs).filter((x): x is number => x !== null);
    console.log(
      `effort ${effort}: ${r.length} lessons, repeated check ${r.filter(x => x.repeatedCheck).length}, valid ${r.filter(x => x.ok).length}, repaired ${r.filter(x => x.repaired).length}, failed ${r.filter(x => !x.ok).length}; ` +
        `first token p50 ${p(r.map(x => x.firstTokenMs), 0.5)} ms; first beat p50 ${p(fb, 0.5)} / p90 ${p(fb, 0.9)} ms; total p50 ${p(r.map(x => x.totalMs), 0.5)} ms; beats avg ${(r.reduce((a, x) => a + x.beats, 0) / Math.max(1, r.length)).toFixed(1)}`
    );
    for (const x of r.filter(y => !y.ok || y.repaired)) console.log(`  ${x.ok ? 'repaired' : 'FAILED'} ${x.label}: ${x.error ?? ''}`.slice(0, 300));
  }
}
const log = (r: Result) =>
  console.log(`[${r.effort}] ${r.label}: ${r.ok ? 'ok' : `FAIL ${r.error?.slice(0, 160)}`}${r.repaired ? ' (repaired)' : ''} first token ${r.firstTokenMs} ms, first beat ${r.firstBeatMs ?? '-'} ms, total ${r.totalMs} ms, ${r.beats} beats`);

main().catch(e => {
  console.error(e);
  process.exit(1);
});
