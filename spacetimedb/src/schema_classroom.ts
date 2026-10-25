// Classroom tables (owner: night/classroom-core, docs/CONTRACT-night.md section 2):
// teachers, presence, class sessions + documents, the simulation and the teacher dashboard.
import { table, t } from 'spacetimedb/server';

export const teacher = table(
  { name: 'teacher', public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    name: t.string(),
    createdAt: t.timestamp(),
  }
);

/** Online state of a student. `connectionId` is the hex id of the connection that set it
 *  (clientDisconnected marks that connection's learners offline). */
export const presence = table(
  { name: 'presence', public: true },
  {
    learnerId: t.u64().primaryKey(),
    /** offline | waiting | in_session */
    status: t.string(),
    connectionId: t.string().index('btree'),
    updatedAt: t.timestamp(),
  }
);

export const classSession = table(
  { name: 'class_session', public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    teacherId: t.u64().index('btree'),
    /** Executive instructions: learning goals. */
    goals: t.string(),
    /** Executive instructions: content to cover. */
    content: t.string(),
    /** Delivery instructions: how to teach. */
    delivery: t.string(),
    documentName: t.string(),
    /** '' (none), text/markdown, or image/(jpeg|png|webp|gif) (payload in class_document). */
    documentMime: t.string(),
    /** Markdown / plain-text document content. */
    documentText: t.string(),
    active: t.bool().index('btree'),
    simulation: t.bool(),
    simulatedCount: t.u32(),
    startedAt: t.timestamp(),
    endedAt: t.option(t.timestamp()),
  }
);

/** Image payload of a class session's document (private; the worker reads it via getSessionImage). */
export const classDocument = table(
  { name: 'class_document' },
  {
    classSessionId: t.u64().primaryKey(),
    data: t.byteArray(),
  }
);

/** Seed records of the 20 simulated students (shared/src/classroom/simStudents.ts). */
export const simProfile = table(
  { name: 'sim_profile', public: true },
  {
    rank: t.u32().primaryKey(),
    name: t.string(),
    age: t.u32(),
    grade: t.u32(),
    style: t.string(),
    persona: t.string(),
    /** JSON string[] */
    misconceptions: t.string(),
    /** JSON SimMemoryNote[] */
    memory: t.string(),
  }
);

/** Next simulated student message for a session (scheduled procedure simStudentTurn). */
export const simTurnJob = table(
  { name: 'sim_turn_job' },
  {
    scheduledId: t.u64().primaryKey().autoInc(),
    scheduledAt: t.scheduleAt(),
    sessionId: t.u64().index('btree'),
    /** Session turnCount when scheduled (a changed count means the job is stale). */
    turnCount: t.u32(),
    attempt: t.u32(),
  }
);

/** Student-LLM calls in flight (concurrency cap; stale after SIM_RUNNING_STALE_S). */
export const simRunning = table(
  { name: 'sim_running' },
  {
    sessionId: t.u64().primaryKey(),
    startedAt: t.timestamp(),
  }
);

export const classSummary = table(
  { name: 'class_summary', public: true },
  {
    classSessionId: t.u64().primaryKey(),
    summary: t.string(),
    updatedAt: t.timestamp(),
    version: t.u32(),
  }
);

export const studentCluster = table(
  { name: 'student_cluster', public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    classSessionId: t.u64().index('btree'),
    position: t.u32(),
    name: t.string(),
    description: t.string(),
    /** JSON string[] of learner ids (u64 as strings). */
    learnerIds: t.string(),
  }
);

export const dashboardState = table(
  { name: 'dashboard_state', public: true },
  {
    classSessionId: t.u64().primaryKey(),
    impersonatingLearnerId: t.u64(),
    lastRunAt: t.option(t.timestamp()),
    nextDueAt: t.timestamp(),
    running: t.bool(),
    /** When the running refresh started (a crashed run counts as stale after a while). */
    runStartedAt: t.option(t.timestamp()),
    /** Last refresh error ('' = ok), for the UI. */
    lastError: t.string(),
  }
);

export const dashboardJob = table(
  { name: 'dashboard_job' },
  {
    scheduledId: t.u64().primaryKey().autoInc(),
    scheduledAt: t.scheduleAt(),
    classSessionId: t.u64().index('btree'),
  }
);
