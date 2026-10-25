// Contract of the teacher-facing student profile (procedure `learnerInsights`, module
// spacetimedb/src/insights.ts). The procedure returns JSON.stringify(LearnerInsightsResult).
// Long-term information only: memory notes, mastery, past session summaries.
// All ids are decimal strings (u64), all times are Unix milliseconds (numbers).
import type { MemoryKind } from './types';

export interface InsightEvidence {
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
  /** true = seeded (simulation profile / demo seed, no evidence), not learned in a session. */
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
    sessionCount: number;
    /** Earliest session start (learner.createdAt when there are no sessions). */
    firstSeenMs: number;
    /** Latest session end (start while active); learner.createdAt when there are no sessions. */
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

export type LearnerInsightsError = 'unknown_teacher' | 'locked' | 'unknown_learner';

export type LearnerInsightsResult = LearnerInsights | { ok: false; error: LearnerInsightsError };

/** Display order of note kinds in the profile. */
export const INSIGHT_KIND_ORDER: readonly MemoryKind[] = ['misconception', 'strategy', 'mnemonic', 'quote', 'understood', 'preference'];
export const INSIGHT_MAX_NOTES = 60;
export const INSIGHT_MAX_SUMMARIES = 5;
export const INSIGHT_EVIDENCE_PER_NOTE = 2;
export const INSIGHT_QUOTE_MAX = 200;
