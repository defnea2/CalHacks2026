// Scripted text (or voice) session against a running worker + module, as a plain client.
// `SPACETIME_DB=night-2min pnpm --filter worker smoke:session [--voice] [--no-opening] [--task "..."] ["turn" ...]`
//
// With the opening (default): startConversation like the client's "Start talking"; the tutor's
// opening (lesson mode: authored lead-in + first lesson) plays, then each scripted turn is sent
// after the previous reply finished. Voice: this script plays the audio like a client (markPlayed
// at each sentence start, then waits the sentence's audio duration) so timings are audio time.
// Text: the module's reading delay plays the sentences.
//
// Reports per reply the latency (turn end -> first beat / sentence / audio) and the ARC TIMELINE:
// seconds after the start click until the explanation (first picture), the formalization (first
// equation shown) and the task (check prompt spoken) were each shown.
import { DbConnection } from './module_bindings/index';
import { OPENING_TURN_IDX } from '@tutor/shared';
import { loadConfig } from './env';

const cfg = loadConfig();
if (['voice-tutor', 'tutor', 'night-base'].includes(cfg.spacetimeDb)) throw new Error(`refusing to script the shared DB ${cfg.spacetimeDb}`);
const argv = process.argv.slice(2);
const voice = argv.includes('--voice');
const opening = !argv.includes('--no-opening');
const taskAt = argv.indexOf('--task');
const task = taskAt >= 0 ? argv[taskAt + 1]! : 'Expand 2/3 so the bottom number is 12.';
const texts = argv.filter((a, i) => !a.startsWith('--') && i !== taskAt + 1);
const turns = texts.length ? texts : opening ? ["I don't know.", "I don't know."] : ['Why is 2/4 the same as 1/2?', "I don't know.", 'show me another way'];
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const ms = (t?: { microsSinceUnixEpoch: bigint } | null) => (t ? Number(t.microsSinceUnixEpoch / 1000n) : NaN);
const sec = (v: number | undefined) => (v === undefined || !Number.isFinite(v) ? '-' : `${(v / 1000).toFixed(1)} s`);

interface BeatInfo { utteranceId: bigint; idx: number; sentenceIdx: number; equationAt: number; picture: boolean; narration: string }

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
      .subscribe(['SELECT * FROM learner', 'SELECT * FROM session', 'SELECT * FROM turn', 'SELECT * FROM beat', 'SELECT * FROM reply_sentence', 'SELECT * FROM turn_metrics', 'SELECT * FROM lesson_state', 'SELECT * FROM agent_status', ...(voice ? ['SELECT * FROM audio_out'] : [])])
  );
  // audio_out is an event table (rows are not kept in the cache): collect them as they arrive.
  const audioRows = new Map<string, { pcm: Uint8Array; sampleRate: number }>();
  conn.db.audioOut.onInsert((_c, a) => audioRows.set(`${a.utteranceId}:${a.idx}`, { pcm: a.pcm, sampleRate: a.sampleRate }));
  const name = `Smoke${Date.now() % 100000}`;
  await conn.reducers.createTestUser({ name, age: 9, grade: 4, style: 'pictures' });
  await sleep(200);
  const learner = [...conn.db.learner.iter()].find(l => l.name === name)!;
  await conn.reducers.startSession({ learnerId: learner.id, taskText: task });
  await sleep(200);
  const session = [...conn.db.session.iter()].filter(s => s.learnerId === learner.id && s.active)[0]!;
  if (!voice) await conn.reducers.setSessionVoice({ sessionId: session.id, voice: false });
  const status = [...conn.db.agentStatus.iter()][0];
  console.log(`session ${session.id} (${voice ? 'voice' : 'text mode'}), task "${task}", agent ${status ? `${status.model} seen ${new Date(ms(status.lastSeen)).toISOString()}` : 'no heartbeat'}`);

  // Sentence start times (local clock): voice = our playback start; text = shown (ready, previous read).
  const startedAt = new Map<string, number>();
  const key = (u: bigint, i: number) => `${u}:${i}`;
  const sentencesOf = (u: bigint) => [...conn.db.replySentence.iter()].filter(s => s.utteranceId === u).sort((a, b) => a.idx - b.idx);
  let stopPlayer = false;
  const player = (async () => {
    while (!stopPlayer) {
      const s = conn.db.session.id.find(session.id)!;
      for (const u of [...new Set([...conn.db.replySentence.iter()].filter(x => x.sessionId === session.id).map(x => x.utteranceId))]) {
        for (const x of sentencesOf(u)) {
          if (startedAt.has(key(u, x.idx))) continue;
          const prev = x.idx === 0 || startedAt.has(key(u, x.idx - 1)) || sentencesOf(u).find(p => p.idx === x.idx - 1)?.status === 'dropped';
          if (!prev) break;
          if (voice) {
            if (x.status === 'dropped') { startedAt.set(key(u, x.idx), NaN); continue; }
            const audio = audioRows.get(key(u, x.idx));
            if (!audio) break;
            startedAt.set(key(u, x.idx), Date.now());
            await conn.reducers.markPlayed({ sessionId: session.id, utteranceId: u, idx: x.idx });
            await sleep((audio.pcm.length / 2 / audio.sampleRate) * 1000 + 150);
          } else {
            if (x.status !== 'ready' && x.status !== 'played') break;
            const before = sentencesOf(u).find(p => p.idx === x.idx - 1);
            if (before && before.status !== 'played') break;
            startedAt.set(key(u, x.idx), Date.now());
          }
        }
      }
      void s;
      await sleep(30);
    }
  })();

  const t0 = Date.now();
  const waitReply = async (afterTutorIdx: number) => {
    let sawUtterance = false;
    const begin = Date.now();
    while (Date.now() - begin < 120_000) {
      const s = conn.db.session.id.find(session.id)!;
      if (s.currentUtteranceId !== 0n) sawUtterance = true;
      const answered = [...conn.db.turn.iter()].some(t => t.sessionId === session.id && t.role === 'tutor' && t.idx > afterTutorIdx);
      if (sawUtterance && s.currentUtteranceId === 0n && s.turnState === 'listening' && answered) return;
      await sleep(100);
    }
    console.log('  (reply did not settle within 120 s)');
  };
  const report = (turnIdx: number, label: string) => {
    const m = [...conn.db.turnMetrics.iter()].find(x => x.sessionId === session.id && x.turnIdx === turnIdx);
    const u = m?.utteranceId ?? 0n;
    const beats = [...conn.db.beat.iter()].filter(b => b.utteranceId === u).sort((a, b) => a.idx - b.idx);
    const lesson = conn.db.lessonState.sessionId.find(session.id);
    const end = ms(m?.turnEndAt);
    const notes = lesson ? (JSON.parse(lesson.notes) as { phase?: string }) : {};
    const words = sentencesOf(u).map(s => s.display).join(' ').split(/\s+/).filter(Boolean).length;
    console.log(
      `\n> ${label}\n  turn end -> first beat ${beats[0] ? ms(beats[0].createdAt) - end : '-'} ms, first sentence ${ms(m?.firstSentenceAt) - end} ms, ` +
        `first audio ${ms(m?.firstAudioAt) - end} ms, llm first token ${ms(m?.llmFirstTokenAt) - end} ms; ${beats.length} beats, ${words} words; phase ${notes.phase ?? '-'}; lesson ${lesson?.stage} "${lesson?.checkPrompt ?? ''}"`
    );
    for (const s of sentencesOf(u)) {
      const b = beats.find(x => x.sentenceIdx === s.idx);
      console.log(`  ${sec(startedAt.get(key(u, s.idx))! - t0).padStart(7)} ${b ? `[beat ${b.idx}] ` : '         '}${s.display}`);
    }
  };

  let tutorIdx = -1;
  if (opening) {
    await conn.reducers.startConversation({ sessionId: session.id });
    await waitReply(-1);
    report(OPENING_TURN_IDX, '(opening)');
    tutorIdx = Math.max(...[...conn.db.turn.iter()].filter(t => t.sessionId === session.id).map(t => t.idx));
  }
  for (const text of turns) {
    const intent = text === 'show me another way' ? 'another_way' : '';
    await conn.reducers.submitTextTurn({ sessionId: session.id, text: intent ? '' : text, intent });
    await sleep(300);
    const studentIdx = Math.max(...[...conn.db.turn.iter()].filter(t => t.sessionId === session.id && t.role === 'student').map(t => t.idx));
    await waitReply(Math.max(tutorIdx, studentIdx));
    report(studentIdx, text);
    tutorIdx = Math.max(...[...conn.db.turn.iter()].filter(t => t.sessionId === session.id).map(t => t.idx));
  }
  stopPlayer = true;
  await player;

  // ARC TIMELINE: explanation = first picture beat shown; formalization = first equation shown
  // (a `-s<k>` keyframe cue or show_math/set_equation visible); task = the check prompt's sentence.
  const all: BeatInfo[] = [...conn.db.beat.iter()]
    .filter(b => b.sessionId === session.id)
    .sort((a, b) => (a.utteranceId === b.utteranceId ? a.idx - b.idx : a.utteranceId < b.utteranceId ? -1 : 1))
    .map(b => {
      const v = JSON.parse(b.visual) as { cues: { id: string; commands: { type: string; visual?: { showEquation?: boolean }; change?: { type: string; visible?: boolean } }[] }[] };
      let equationAt = -1;
      let picture = false;
      for (const cue of v.cues) {
        const k = Number(/-s(\d+)$/.exec(cue.id)?.[1] ?? 0);
        for (const c of cue.commands) {
          if (c.type === 'show_math' || (c.type === 'update_math' && c.change?.type !== 'set_equation' && c.change?.type !== 'set_interaction')) picture = true;
          if ((c.type === 'show_math' && c.visual?.showEquation) || (c.type === 'update_math' && c.change?.type === 'set_equation' && c.change.visible)) if (equationAt < 0) equationAt = b.sentenceIdx + k;
        }
      }
      return { utteranceId: b.utteranceId, idx: b.idx, sentenceIdx: b.sentenceIdx, equationAt, picture, narration: b.narration };
    });
  const at = (u: bigint, i: number) => startedAt.get(key(u, i));
  const expl = all.find(b => b.picture);
  const formal = all.find(b => b.equationAt >= 0);
  const checks = [...conn.db.replySentence.iter()].filter(s => s.sessionId === session.id).sort((a, b) => (a.utteranceId === b.utteranceId ? a.idx - b.idx : a.utteranceId < b.utteranceId ? -1 : 1));
  const lessonPrompt = conn.db.lessonState.sessionId.find(session.id)?.checkPrompt;
  // The first task: the final sentence of the first utterance with a beat (its check prompt).
  const firstLessonU = all[0]?.utteranceId;
  const taskSentence = firstLessonU ? checks.filter(s => s.utteranceId === firstLessonU).at(-1) : undefined;
  const taskEnd = taskSentence ? at(taskSentence.utteranceId, taskSentence.idx + 1) : undefined;
  const lastStart = taskSentence ? at(taskSentence.utteranceId, taskSentence.idx) : undefined;
  console.log(`\nARC TIMELINE (${voice ? 'voice, audio time' : 'text mode, reading time'}; seconds after ${opening ? 'the start click' : 'the first turn'}):`);
  console.log(`  explanation   (first picture)      ${sec(expl ? at(expl.utteranceId, expl.sentenceIdx)! - t0 : undefined)}`);
  console.log(`  formalization (first equation)     ${sec(formal ? at(formal.utteranceId, formal.equationAt)! - t0 : undefined)}${formal ? `  "${formal.narration.slice(0, 80)}"` : ''}`);
  console.log(`  task          (check prompt spoken) ${sec(lastStart !== undefined ? lastStart - t0 : undefined)}  "${taskSentence?.display ?? ''}"${taskEnd ? '' : ''}`);
  console.log(`  last check now: "${lessonPrompt ?? ''}"`);
  conn.disconnect();
  process.exit(0);
}
main().catch(e => {
  console.error(e);
  process.exit(1);
});
