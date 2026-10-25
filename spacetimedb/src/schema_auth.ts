// Identity and authorization tables (auth.ts, docs/ARCHITECTURE.md "Identity and authorization").
// All private: clients read their own rows only through the views in auth.ts (my_learners,
// my_teachers, my_students).
import { table, t } from 'spacetimedb/server';

/** Identity -> account it may act as. One identity (a device) can own several accounts; an
 *  account can be linked to several devices (sign-in codes). */
export const accountLink = table(
  { name: 'account_link' },
  {
    id: t.u64().primaryKey().autoInc(),
    identity: t.identity().index('btree'),
    /** learner | teacher */
    kind: t.string(),
    accountId: t.u64().index('btree'),
    /** created | code | claimed */
    via: t.string(),
    createdAt: t.timestamp(),
  }
);

/** Students a teacher added ("Add student"); together with past class sessions this is who
 *  the teacher may issue codes for and read profiles of. */
export const teacherStudent = table(
  { name: 'teacher_student' },
  {
    id: t.u64().primaryKey().autoInc(),
    teacherId: t.u64().index('btree'),
    learnerId: t.u64().index('btree'),
    createdAt: t.timestamp(),
  }
);

/** One-time sign-in codes. Only the hash is stored: sha256(AGENT_SECRET pepper + code). */
export const signInCode = table(
  { name: 'sign_in_code' },
  {
    id: t.u64().primaryKey().autoInc(),
    codeHash: t.string().unique(),
    kind: t.string(),
    accountId: t.u64().index('btree'),
    issuedBy: t.identity(),
    createdAt: t.timestamp(),
    expiresAt: t.timestamp(),
  }
);

/** Failed linkDevice attempts per identity (brute-force throttle). */
export const codeAttempt = table(
  { name: 'code_attempt' },
  {
    identity: t.identity().primaryKey(),
    windowStartMicros: t.u64(),
    failures: t.u32(),
  }
);

/** Singleton (id 0): when authorization was switched on in this database. Accounts created
 *  before it without any link are legacy rows the first identity may claim once. */
export const authMeta = table(
  { name: 'auth_meta' },
  {
    id: t.u32().primaryKey(),
    enabledAt: t.timestamp(),
  }
);
