// Contract of the teacher-facing student profile (procedure `learnerInsights`, module
// spacetimedb/src/insights.ts). The procedure returns JSON.stringify(LearnerInsightsResult).
// Long-term information only: memory notes, mastery, past session summaries.
// All ids are decimal strings (u64), all times are Unix milliseconds (numbers).
import type { MemoryKind } from './types';

export interface InsightEvidence {
  /** Decimal session id; 'seed-<n>' for seeded evidence (demo seed / simulation profile), which
   *  matches the sessionId of that seeded summary. */
  sessionId: string;
  fromTurn: number;
  toTurn: number;
  /** Quote from the transcript backing the note, at most 200 chars; '' for notes the tutor
   *  saved with its remember tool (then only the turn range is known). */
  quote: string;
}

export interface InsightNote {
  id: string;
  kind: MemoryKind;
  /** Category key ('' if not tied to one). */
  category: string;
  /** Concept key ('' if not tied to one). */
  concept: string;
  /** Concept title from the content library ('' if unknown / none). */
  conceptTitle: string;
  /** Human-readable learning about the student. */
  text: string;
  outcome: 'worked' | 'didnt' | 'unknown';
  /** 0..1 */
  confidence: number;
  /** How often later windows confirmed the note. */
  reinforced: number;
  createdMs: number;
  updatedMs: number;
  /** true = seeded (simulation profile or demo seed), not learned in a session: only seed
   *  evidence (sessionId 'seed-<n>'). */
  seeded: boolean;
  /** Last (up to) 2 evidence rows, newest first. */
  evidence: InsightEvidence[];
}

export interface InsightMastery {
  concept: string;
  title: string;
  category: string;
  categoryTitle: string;
  /** 0..100 */
  mastery: number;
  updatedMs: number;
}

export interface InsightSummary {
  /** Decimal session id; 'seed-<n>' for a seeded earlier session (no session row; task and
   *  topic come from the seed, '' when the seed gave none). */
  sessionId: string;
  summary: string;
  nextFocus: string;
  createdMs: number;
  taskText: string;
  /** Concept key of the session ('' if no topic was set). */
  topic: string;
  /** Concept title (falls back to the category title, then ''). */
  topicTitle: string;
}

export interface LearnerInsights {
  ok: true;
  learner: {
    id: string;
    name: string;
    age: number;
    grade: number;
    style: string;
    isSimulated: boolean;
    /** Simulation persona ('' for real learners). */
    persona: string;
    /** Real sessions + seeded earlier sessions. */
    sessionCount: number;
    /** Earliest session start, seeded sessions included (learner.createdAt when there are none). */
    firstSeenMs: number;
    /** Latest session end (start while active; a seeded session's date); learner.createdAt when there are none. */
    lastSeenMs: number;
  };
  /** Ordered by kind (misconception, strategy, mnemonic, quote, understood, preference),
   *  then updatedMs desc. At most 60. */
  notes: InsightNote[];
  /** Ordered by updatedMs desc. */
  mastery: InsightMastery[];
  /** Last 5 session summaries, newest first. */
  summaries: InsightSummary[];
  generatedMs: number;
}

/** not_your_teacher: the caller's device is not signed in as that teacher; not_your_student: the
 *  learner is not on that teacher's roster (docs/ARCHITECTURE.md "Identity and authorization"). */
export type LearnerInsightsError = 'unknown_teacher' | 'locked' | 'unknown_learner' | 'not_your_teacher' | 'not_your_student';

export type LearnerInsightsResult = LearnerInsights | { ok: false; error: LearnerInsightsError };

/** Display order of note kinds in the profile. */
export const INSIGHT_KIND_ORDER: readonly MemoryKind[] = ['misconception', 'strategy', 'mnemonic', 'quote', 'understood', 'preference'];
export const INSIGHT_MAX_NOTES = 60;
export const INSIGHT_MAX_SUMMARIES = 5;
export const INSIGHT_EVIDENCE_PER_NOTE = 2;
export const INSIGHT_QUOTE_MAX = 200;
