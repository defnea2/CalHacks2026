// Real-model teaching check without STT, TTS, a database, or a microphone.
// Uses the production agent/router/player with an in-memory transport. Assertions
// check the visual teaching conditions; narration still needs human review.
import assert from 'node:assert/strict';
import { loadConfig } from '../worker/src/env';
import { createLlm } from '../worker/src/providers';
import { teachingOutput } from '../worker/src/teachingOutput';
import { FakeTransport, makeAgent, session, turn, waitFor } from '../worker/test/fakes';
import { SpeechCanvasPlayer } from '../src/presentation/voice/SpeechCanvasPlayer';
import type { MathVisual } from '../src/presentation/math/models';

const cfg = loadConfig();
const { llm, info } = createLlm(cfg);
const scenarios = [
  { name: 'Compare fractions', prompts: [
    'I think one quarter is bigger than one half because four is bigger than two. Please show both amounts together using equal whole bars.',
    'I see one half covers more than one quarter. Split the half into quarters without changing how much is shaded, and show the equivalence.',
  ], check(visual: MathVisual, index: number) {
    assert.equal(visual.kind, 'bars');
    if (visual.kind !== 'bars') return;
    if (index === 0) {
      assert.ok(visual.bars.some(b => b.parts === 2 && b.shaded === 1), 'Comparison lost the half');
      assert.ok(visual.bars.some(b => b.parts === 4 && b.shaded === 1), 'Comparison lost the quarter');
    } else assert.ok(visual.bars.some(b => b.parts === 4 && b.shaded === 2), 'Repartition changed the shaded amount');
  } },
  { name: 'Split multiplication', prompts: [
    'I know three times five is fifteen, but three times seven is hard. Show me how to split three rows of seven into five and two in each row.',
  ], check(visual: MathVisual) {
    assert.equal(visual.kind, 'array');
    if (visual.kind === 'array') assert.deepEqual([visual.rows, visual.columns, visual.splitAt], [3, 7, 5]);
  } },
];

async function main() {
  console.log(info);
  for (const scenario of scenarios) {
    const transport = new FakeTransport();
    transport.topicResult = JSON.stringify({ ok: true, material: {}, notes: [], note: 'No library entries. Create an appropriate example.' });
    const { agent } = makeAgent(teachingOutput(llm), transport, { toolTimeoutMs: 10000 });
    agent.onSession(session(1n));
    let board = 'empty';
    try {
      for (const [i, prompt] of scenario.prompts.entries()) {
        transport.context = `Learner: Synthetic learner, age 9. Original task: ${scenario.prompts[0]}. Current phase: diagnose. Board right now: ${board}`;
        const t0 = Date.now();
        agent.onTurn(turn(1n, i * 2, prompt));
        await waitFor(() => transport.of('appendTutorTurn').length > i, 60000, 'generated teaching response');
        const tutor = transport.of('appendTutorTurn')[i]!;
        const boards = transport.of('showBoardItem').filter(b => b.utteranceId === tutor.utteranceId && b.kind === 'math_canvas');
        assert.equal(boards.length, 1, 'Expected one generated canvas');
        const content = JSON.parse(String(boards[0]!.content));
        const sentences = transport.of('addSentence').filter(s => s.utteranceId === tutor.utteranceId);
        assert.deepEqual(sentences.map(s => s.display), content.moments.map((m: { narration: string }) => m.narration), 'Speech diverged from its visual plan');
        const player = new SpeechCanvasPlayer();
        player.sync([{ id: '1', order: 0, utteranceId: '1', sentenceIdx: 0, content }], new Map([['1', sentences.map(s => Number(s.idx))]]), true);
        assert.equal(player.error, null);
        const visual = player.director.getSnapshot().canvas.math?.visual;
        assert.ok(visual);
        console.log(`${scenario.name}, turn ${i + 1}, ${Date.now() - t0}ms: ${JSON.stringify(content)}`);
        scenario.check(visual, i);
        board = JSON.stringify(content);
        agent.onTurn(turn(1n, i * 2 + 1, String(tutor.text), 'done', 'tutor'));
      }
      console.log(`PASS: ${scenario.name}`);
    } finally { agent.closeAll(); }
  }
}

main().catch(error => {
  let message = error instanceof Error ? error.message : String(error);
  for (const key of [cfg.anthropicApiKey, cfg.openrouterApiKey, cfg.agentSecret]) if (key) message = message.split(key).join('[redacted]');
  console.error(message);
  process.exitCode = 1;
});
