// The worker subscribes to active sessions only: per-session tables arrive through JOIN
// subscriptions on `session.active`, never table-wide (history stays on the server).
import { describe, expect, it } from 'vitest';
import { SUBSCRIPTIONS } from '../src/stdb';

const PER_SESSION = ['turn', 'phrase', 'reply_sentence', 'board_item', 'learner'];
const tableOf = (q: string) => /FROM\s+(\w+)/i.exec(q)![1]!;

describe('worker subscriptions', () => {
  it('per-session tables are limited to active sessions', () => {
    for (const t of PER_SESSION) {
      const qs = SUBSCRIPTIONS.filter(q => tableOf(q) === t);
      expect(qs, t).toHaveLength(1);
      expect(qs[0]).toMatch(/JOIN session s ON \w+\.(session_id|id) = s\.(id|learner_id) WHERE s\.active = true$/);
    }
  });

  it('no table-wide query except the event tables', () => {
    const wide = SUBSCRIPTIONS.filter(q => !/WHERE/i.test(q)).map(tableOf).sort();
    expect(wide).toEqual(['playback_flush', 'speech_activity']);
  });
});
