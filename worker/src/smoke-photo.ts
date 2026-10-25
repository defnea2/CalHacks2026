// Turn photo live check: text session, attachImage(<jpeg>), one typed turn, prints the tutor's
// reply (beats + tutor turn) so you can see whether it refers to the photo.
// `SPACETIME_DB=night-photo pnpm --filter worker exec tsx src/smoke-photo.ts <photo.jpg> ["turn text"]`
import { readFileSync } from 'node:fs';
import { DbConnection } from './module_bindings/index';
import { loadConfig } from './env';

const cfg = loadConfig();
if (['voice-tutor', 'tutor', 'night-base'].includes(cfg.spacetimeDb)) throw new Error(`refusing to script the shared DB ${cfg.spacetimeDb}`);
// --session-only: just create an active text session and print its id (for screenshots).
const sessionOnly = process.argv.includes('--session-only');
const [file, text = 'Can you help me with this one?'] = process.argv.slice(2).filter(a => !a.startsWith('--'));
if (!file && !sessionOnly) throw new Error('usage: smoke-photo.ts <photo.jpg> ["turn text"]');
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function main() {
  const conn = await new Promise<DbConnection>((resolve, reject) =>
    DbConnection.builder().withUri(cfg.spacetimeUri).withDatabaseName(cfg.spacetimeDb).onConnect(c => resolve(c)).onConnectError((_c, e) => reject(e)).build()
  );
  await new Promise<void>(r => conn.subscriptionBuilder().onApplied(() => r()).subscribe(['SELECT * FROM learner', 'SELECT * FROM session', 'SELECT * FROM turn', 'SELECT * FROM beat']));
  const name = `Photo${Date.now() % 100000}`;
  await conn.reducers.createTestUser({ name, age: 9, grade: 4, style: 'pictures' });
  await sleep(200);
  const learner = [...conn.db.learner.iter()].find(l => l.name === name)!;
  await conn.reducers.startSession({ learnerId: learner.id, taskText: 'My homework' });
  await sleep(200);
  const session = [...conn.db.session.iter()].find(s => s.learnerId === learner.id && s.active)!;
  await conn.reducers.setSessionVoice({ sessionId: session.id, voice: false });
  if (sessionOnly) {
    console.log(`SESSION ${session.id}`);
    process.exit(0);
  }
  await conn.reducers.attachImage({ sessionId: session.id, mime: 'image/jpeg', data: new Uint8Array(readFileSync(file!)) });
  await sleep(200);
  console.log(`session ${session.id}: pendingPhoto=${conn.db.session.id.find(session.id)?.pendingPhoto}`);
  await conn.reducers.submitTextTurn({ sessionId: session.id, text, intent: '' });
  await sleep(300);
  const st = [...conn.db.turn.iter()].find(t => t.sessionId === session.id && t.role === 'student')!;
  console.log(`student turn ${st.idx} "${st.text}" hasPhoto=${st.hasPhoto}; pendingPhoto=${conn.db.session.id.find(session.id)?.pendingPhoto}`);
  const t0 = Date.now();
  while (Date.now() - t0 < 60_000) {
    const tutor = [...conn.db.turn.iter()].find(t => t.sessionId === session.id && t.role === 'tutor');
    if (tutor) {
      const beats = [...conn.db.beat.iter()].filter(b => b.sessionId === session.id).sort((a, b) => a.idx - b.idx);
      for (const b of beats) console.log(`beat ${b.idx}: ${b.narration}`);
      console.log(`tutor turn: ${tutor.text}`);
      break;
    }
    await sleep(500);
  }
  await conn.reducers.endSession({ sessionId: session.id });
  conn.disconnect();
  process.exit(0);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
