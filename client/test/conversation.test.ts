import { describe, expect, it } from 'vitest';
import { OPENING_TURN_IDX } from '@tutor/shared';
import { metricsSortKey, metricsTurnLabel, shouldStartConversation } from '../src/lib/conversation';

describe('tutor speaks first', () => {
  it('asks for the opening only on an active session without turns', () => {
    expect(shouldStartConversation({ active: true, turnCount: 0 })).toBe(true);
    expect(shouldStartConversation({ active: true, turnCount: 3 })).toBe(false); // reload of a running session
    expect(shouldStartConversation({ active: false, turnCount: 0 })).toBe(false);
    expect(shouldStartConversation(undefined)).toBe(false);
  });

  it('labels and orders the opening metrics row first', () => {
    expect(metricsTurnLabel(OPENING_TURN_IDX)).toBe('opening');
    expect(metricsTurnLabel(2)).toBe('2');
    expect([3, OPENING_TURN_IDX, 0].sort((a, b) => metricsSortKey(a) - metricsSortKey(b))).toEqual([OPENING_TURN_IDX, 0, 3]);
  });
});
