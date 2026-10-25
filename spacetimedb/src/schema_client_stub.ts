// TEMPORARY (night/client-static): stub of the docs/CONTRACT-night.md section 1 tables so the
// client can generate bindings before night/pipeline lands. Reverted before merging it.
import { table, t } from 'spacetimedb/server';

export const learnerEvent = table(
  { name: 'learner_event', public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    sessionId: t.u64().index('btree'),
    kind: t.string(),
    payload: t.string(),
    accepted: t.bool(),
    evidence: t.string(),
    createdAt: t.timestamp(),
  }
);

export const canvasState = table(
  { name: 'canvas_state', public: true },
  { sessionId: t.u64().primaryKey(), version: t.u32(), scene: t.string(), updatedAt: t.timestamp() }
);

export const beat = table(
  { name: 'beat', public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    sessionId: t.u64().index('btree'),
    utteranceId: t.u64(),
    idx: t.u32(),
    visual: t.string(),
    narration: t.string(),
    sentenceIdx: t.i32(),
    canvasVersion: t.u32(),
    createdAt: t.timestamp(),
  }
);

export const lessonState = table(
  { name: 'lesson_state', public: true },
  {
    sessionId: t.u64().primaryKey(),
    stage: t.string(),
    awaitingResponse: t.bool(),
    checkPrompt: t.string(),
    evidence: t.string(),
    notes: t.string(),
    updatedAt: t.timestamp(),
  }
);

export const agentStatus = table(
  { name: 'agent_status', public: true },
  { id: t.u32().primaryKey(), model: t.string(), provider: t.string(), busySessions: t.u32(), lastSeen: t.timestamp() }
);
