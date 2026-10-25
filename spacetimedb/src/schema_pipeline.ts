// Tables of the turn pipeline (contract section 1, owner night/pipeline): text mode and the team
// lesson planner (beats compiled against canvas_state, learner events, lesson state, agent status).
import { table, t } from 'spacetimedb/server';

// ---------------------------------------------------------------- text mode (session.voice = false)

/** Scheduled: a text-mode sentence has been "read" (its reading delay passed) -> played. */
export const textPlayJob = table(
  { name: 'text_play_job' },
  {
    scheduledId: t.u64().primaryKey().autoInc(),
    scheduledAt: t.scheduleAt(),
    sessionId: t.u64(),
    sentenceId: t.u64(),
    utteranceId: t.u64(),
    idx: t.u32(),
  }
);

/** Reading clock of a text-mode session: when the last queued sentence of `utteranceId` ends
 *  (sentences are read one after another). Private. */
export const textPlayback = table(
  { name: 'text_playback' },
  {
    sessionId: t.u64().primaryKey(),
    utteranceId: t.u64(),
    endsAtMicros: t.u64(),
  }
);
