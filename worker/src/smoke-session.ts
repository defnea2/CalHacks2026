// Scripted text (or voice-flagged) session against a running worker + module, as a plain client.
// `SPACETIME_DB=night-pipe pnpm --filter worker smoke:session [--voice] ["question" "answer" ...]`
// Per student turn: turn end -> first beat / first sentence / first audio, beats, lesson stage.
import { DbConnection } from './module_bindings/index';
import { loadConfig } from './env';

const cfg = loadConfig();
if (['voice-tutor', 'tutor', 'night-base'].includes(cfg.spacetimeDb)) throw new Error(`refusing to script the shared DB ${cfg.spacetimeDb}`);
const voice = process.argv.includes('--voice');
const texts = process.argv.slice(2).filter(a => !a.startsWith('--'));
const turns = texts.length ? texts : ['Why is 2/4 the same as 1/2?', 'Because the pieces are smaller but the same part is shaded.', 'show me another way'];
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const ms = (t?: { microsSinceUnixEpoch: bigint } | null) => (t ? Number(t.microsSinceUnixEpoch / 1000n) : NaN);

async function main() {
  const conn = await new Promise<DbConnection>((resolve, reject) =>
    DbConnection.builder()
      .withUri(cfg.spacetimeUri)
      .withDatabaseName(cfg.spacetimeDb)
      .onConnect(c => resolve(c))
      .onConnectError((_c, e) => reject(e))
      .build()
  );
  await new Promise<void>(r =>
    conn
      .subscriptionBuilder()
      .onApplied(() => r())
      .subscribe(['SELECT * FROM learner', 'SELECT * FROM session', 'SELECT * FROM turn', 'SELECT * FROM beat', 'SELECT * FROM reply_sentence', 'SELECT * FROM turn_metrics', 'SELECT * FROM lesson_state', 'SELECT * FROM agent_status'])
  );
  const name = `Smoke${Date.now() % 100000}`;
  await conn.reducers.createTestUser({ name, age: 9, grade: 4, style: 'pictures' });
  await sleep(200);
  const learner = [...conn.db.learner.iter()].find(l => l.name === name)!;
  await conn.reducers.startSession({ learnerId: learner.id, taskText: 'Equivalent fractions' });
  await sleep(200);
  const session = [...conn.db.session.iter()].filter(s => s.learnerId === learner.id && s.active)[0]!;
  if (!voice) await conn.reducers.setSessionVoice({ sessionId: session.id, voice: false });
  const status = [...conn.db.agentStatus.iter()][0];
  console.log(`session ${session.id} (${voice ? 'voice' : 'text mode'}), agent ${status ? `${status.model} seen ${new Date(ms(status.lastSeen)).toISOString()}` : 'no heartbeat'}`);
  for (const text of turns) {
    const intent = text === 'show me another way' ? 'another_way' : '';
    await conn.reducers.submitTextTurn({ sessionId: session.id, text: intent ? '' : text, intent });
    const t0 = Date.now();
    await sleep(300);
    const studentIdx = Math.max(...[...conn.db.turn.iter()].filter(t => t.sessionId === session.id && t.role === 'student').map(t => t.idx));
    // Wait until the reply finished (listening after an utterance) or 60 s.
    let sawUtterance = false;
    while (Date.now() - t0 < 60_000) {
      const s = conn.db.session.id.find(session.id)!;
      if (s.currentUtteranceId !== 0n) sawUtterance = true;
      const answered = [...conn.db.turn.iter()].some(t => t.sessionId === session.id && t.role === 'tutor' && t.idx > studentIdx);
      if (sawUtterance && s.currentUtteranceId === 0n && s.turnState === 'listening' && answered) break;
      await sleep(100);
    }
    const m = [...conn.db.turnMetrics.iter()].find(x => x.sessionId === session.id && x.turnIdx === studentIdx);
    const u = m?.utteranceId ?? 0n;
    const beats = [...conn.db.beat.iter()].filter(b => b.utteranceId === u).sort((a, b) => a.idx - b.idx);
    const lesson = conn.db.lessonState.sessionId.find(session.id);
    const end = ms(m?.turnEndAt);
    console.log(
      `\n> ${text}\n  turn end -> first beat ${beats[0] ? ms(beats[0].createdAt) - end : '-'} ms, first sentence ${ms(m?.firstSentenceAt) - end} ms, ` +
        `first audio ${ms(m?.firstAudioAt) - end} ms, llm first token ${ms(m?.llmFirstTokenAt) - end} ms; ${beats.length} beats; lesson ${lesson?.stage} "${lesson?.checkPrompt ?? ''}"`
    );
    for (const b of beats) console.log(`  beat ${b.idx} (sentence ${b.sentenceIdx}): ${b.narration}`);
  }
  conn.disconnect();
}
main().catch(e => {
  console.error(e);
  process.exit(1);
});
