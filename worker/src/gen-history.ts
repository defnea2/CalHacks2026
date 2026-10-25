// Dev tool: fills a scratch database with session history (text mode, scripted tutor replies,
// no LLM/TTS) so subscription sizes can be measured on a database that has been used.
// `SPACETIME_DB=night-hardening tsx src/gen-history.ts [learners=10] [sessionsPerLearner=3] [turnsPerSession=8] [activeLeft=2]`
// Refuses the shared databases.
import { DbConnection } from './module_bindings/index';
import { loadConfig } from './env';

const cfg = loadConfig();
if (['voice-tutor', 'tutor', 'night-base'].includes(cfg.spacetimeDb)) throw new Error(`refusing to write to the shared DB ${cfg.spacetimeDb}`);
const [learners = 10, perLearner = 3, turnsPer = 8, activeLeft = 2] = process.argv.slice(2).map(Number);
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function until(f: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!f()) {
    if (Date.now() > end) throw new Error('timeout');
    await sleep(20);
  }
}

async function main() {
  const conn = await new Promise<DbConnection>((resolve, reject) =>
    DbConnection.builder().withUri(cfg.spacetimeUri).withDatabaseName(cfg.spacetimeDb).onConnect(c => resolve(c)).onConnectError((_c, e) => reject(e)).build()
  );
  await conn.reducers.registerAgent({ secret: cfg.agentSecret });
  await new Promise<void>(r => conn.subscriptionBuilder().onApplied(() => r()).subscribe(['SELECT * FROM learner', 'SELECT * FROM session', 'SELECT * FROM turn']));
  let utt = BigInt(Date.now()) * 1000n;
  const total = learners * perLearner;
  let n = 0;
  for (let l = 0; l < learners; l++) {
    const name = `Hist${Date.now() % 100000}-${l}`;
    await conn.reducers.createTestUser({ name, age: 9, grade: 4, style: 'pictures' });
    await until(() => [...conn.db.learner.iter()].some(x => x.name === name));
    const learner = [...conn.db.learner.iter()].find(x => x.name === name)!;
    for (let k = 0; k < perLearner; k++) {
      n++;
      await conn.reducers.startSession({ learnerId: learner.id, taskText: `Task ${k}: add 1/4 + 2/4` });
      await until(() => [...conn.db.session.iter()].some(s => s.learnerId === learner.id && s.active && s.taskText.startsWith(`Task ${k}:`)));
      const s = [...conn.db.session.iter()].find(x => x.learnerId === learner.id && x.active)!;
      await conn.reducers.setSessionVoice({ sessionId: s.id, voice: false });
      for (let t = 0; t < turnsPer; t++) {
        const before = [...conn.db.turn.iter()].filter(x => x.sessionId === s.id).length;
        await conn.reducers.submitTextTurn({ sessionId: s.id, text: `my answer number ${t} is three quarters`, intent: '' });
        await until(() => [...conn.db.turn.iter()].filter(x => x.sessionId === s.id).length > before);
        const last = [...conn.db.turn.iter()].filter(x => x.sessionId === s.id && x.role === 'student').sort((a, b) => b.idx - a.idx)[0]!;
        const u = ++utt;
        await conn.reducers.beginUtterance({ sessionId: s.id, utteranceId: u, replyToIdx: last.idx, preemptive: false });
        const text: string[] = [];
        for (let i = 0; i < 3; i++) {
          const line = `Sentence ${i} of reply ${t}: one quarter plus two quarters is three quarters.`;
          text.push(line);
          await conn.reducers.addSentence({ sessionId: s.id, utteranceId: u, idx: i, display: line, speech: line });
        }
        await conn.reducers.appendTutorTurn({ sessionId: s.id, utteranceId: u, text: text.join(' '), interrupted: false });
      }
      if (n <= total - activeLeft) await conn.reducers.endSession({ sessionId: s.id });
      process.stdout.write(`\rsessions ${n}/${total}`);
    }
  }
  console.log('\ndone');
  conn.disconnect();
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
