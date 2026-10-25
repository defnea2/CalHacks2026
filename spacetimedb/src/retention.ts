// Retention: a scheduled sweep (retention_job, one interval row) deletes data that is only needed
// while a session runs (docs/ARCHITECTURE.md §2 "Retention").
//
// - Photo bytes (turn_image, session_image) RETENTION_IMAGE_MIN minutes (default 30) after their
//   session ended; class_document image bytes the same time after the class session ended.
//   `0` / `off` keeps them. The flags (`session.hasImage`, `turn.hasPhoto`) stay as history.
// - Optional (RETENTION_DAYS, default off): the planner's private JSON of ended sessions older
//   than that many days (lesson_record, lesson_plan) and their public beat rows.
// Everything else (turns, sentences, metrics, memory, summaries, lesson_state) is kept.
// Idempotent: a sweep only deletes rows past their limit; running it twice is a no-op.
import { ScheduleAt } from 'spacetimedb';
import { type Ctx } from './ctx';
import { readEnv } from './env';

/** Sweep interval. */
export const RETENTION_SWEEP_S = 300;
export const RETENTION_IMAGE_MIN_DEFAULT = 30;

const minutes = (m: number) => BigInt(Math.round(m * 60_000_000));

/** Minutes after the session ended that photo bytes are kept; null = forever. */
export function retentionImageMin(ctx: { env: unknown }): number | null {
  const v = readEnv(ctx, 'RETENTION_IMAGE_MIN')?.toLowerCase();
  if (v === undefined) return RETENTION_IMAGE_MIN_DEFAULT;
  if (v === 'off' || v === '0') return null;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : RETENTION_IMAGE_MIN_DEFAULT;
}

/** Days after the session ended that lesson JSON is kept; null (default) = forever. */
export function retentionDays(ctx: { env: unknown }): number | null {
  const v = readEnv(ctx, 'RETENTION_DAYS')?.toLowerCase();
  if (v === undefined || v === 'off' || v === '0') return null;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** The single interval row (init + connect: databases created before retention get it too). */
export function ensureRetentionJob(ctx: Ctx): void {
  const jobs = [...ctx.db.retentionJob.iter()];
  if (jobs.length === 1) return;
  for (const j of jobs.slice(1)) ctx.db.retentionJob.scheduledId.delete(j.scheduledId);
  if (jobs.length === 0) {
    ctx.db.retentionJob.insert({ scheduledId: 0n, scheduledAt: ScheduleAt.interval(BigInt(RETENTION_SWEEP_S) * 1_000_000n) });
  }
}

export interface RetentionResult {
  turnImages: number;
  sessionImages: number;
  classDocuments: number;
  lessonSessions: number;
}

/** endedAt of a session (undefined while active). A missing session counts as long ended. */
function endedAt(ctx: Ctx, sessionId: bigint): bigint | undefined {
  const s = ctx.db.session.id.find(sessionId);
  if (!s) return 0n;
  if (s.active) return undefined;
  return s.endedAt?.microsSinceUnixEpoch ?? 0n;
}

export function sweepRetention(ctx: Ctx): RetentionResult {
  const now = ctx.timestamp.microsSinceUnixEpoch;
  const out: RetentionResult = { turnImages: 0, sessionImages: 0, classDocuments: 0, lessonSessions: 0 };
  const imageMin = retentionImageMin(ctx);
  if (imageMin !== null) {
    const cutoff = now - minutes(imageMin);
    const expired = (sessionId: bigint) => {
      const end = endedAt(ctx, sessionId);
      return end !== undefined && end <= cutoff;
    };
    for (const img of [...ctx.db.turnImage.iter()]) {
      if (expired(img.sessionId) && ctx.db.turnImage.id.delete(img.id)) out.turnImages++;
    }
    for (const img of [...ctx.db.sessionImage.iter()]) {
      if (expired(img.sessionId) && ctx.db.sessionImage.sessionId.delete(img.sessionId)) out.sessionImages++;
    }
    for (const doc of [...ctx.db.classDocument.iter()]) {
      const cls = ctx.db.classSession.id.find(doc.classSessionId);
      const end = !cls ? 0n : cls.active ? undefined : (cls.endedAt?.microsSinceUnixEpoch ?? 0n);
      if (end !== undefined && end <= cutoff && ctx.db.classDocument.classSessionId.delete(doc.classSessionId)) out.classDocuments++;
    }
  }
  const days = retentionDays(ctx);
  if (days !== null) {
    const cutoff = now - minutes(days * 24 * 60);
    const sessions = new Set<bigint>();
    for (const r of ctx.db.lessonRecord.iter()) sessions.add(r.sessionId);
    for (const p of ctx.db.lessonPlan.iter()) sessions.add(p.sessionId);
    for (const sessionId of sessions) {
      const end = endedAt(ctx, sessionId);
      if (end === undefined || end > cutoff) continue;
      ctx.db.lessonRecord.sessionId.delete(sessionId);
      ctx.db.lessonPlan.sessionId.delete(sessionId);
      ctx.db.beat.sessionId.delete(sessionId);
      out.lessonSessions++;
    }
  }
  return out;
}
