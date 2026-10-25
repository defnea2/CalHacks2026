// The tutor speaks first: "Start talking" on a session where nothing was said yet asks the
// module (startConversation) for an opening reply. It is called after the click created the
// AudioContext, so the greeting can be heard. The module checks again and ignores repeats,
// so a reload of a session that already has turns never greets twice. Observers never call it.
import { OPENING_TURN_IDX } from '@tutor/shared';

export function shouldStartConversation(s: { active: boolean; turnCount: number } | undefined): boolean {
  return !!s && s.active && s.turnCount === 0;
}

/** Label for a turn_metrics row: the opening reply has no student turn. */
export function metricsTurnLabel(turnIdx: number): string {
  return turnIdx === OPENING_TURN_IDX ? 'opening' : String(turnIdx);
}

/** Sort key for turn_metrics rows: the opening comes first. */
export function metricsSortKey(turnIdx: number): number {
  return turnIdx === OPENING_TURN_IDX ? -1 : turnIdx;
}
