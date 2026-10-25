import { describe, expect, it } from 'vitest';
import { BeatCanvasPlayer, latestUtteranceBeats, orderBeats, parseScene, readingMs, revealCount, type OrderedBeat } from '../src/lesson/beatPlayer';
import { agentStatusView, AGENT_STALE_MS } from '../src/session/useAgentStatus';
import { typedTurnText } from '../src/components/session';

const array = (rows: number, columns: number) => [{ type: 'show_math', visual: { id: 'groups', kind: 'array', title: 'Groups', rows, columns } }];
const row = (utteranceId: bigint, idx: number, visual: unknown, narration = `Beat ${idx}.`) => ({
  id: BigInt(Number(utteranceId) * 10 + idx), sessionId: 1n, utteranceId, idx, visual: JSON.stringify(visual), narration, sentenceIdx: idx, canvasVersion: idx + 1,
});

describe('orderBeats', () => {
  it('orders by utterance then idx, waits at gaps and keeps unparseable rows as errors', () => {
    const beats = orderBeats([row(5n, 1, array(2, 2)), row(3n, 0, array(1, 1)), row(5n, 0, array(2, 3)), row(5n, 3, array(4, 4)), row(7n, 0, 'nope')]);
    expect(beats.map(b => b.key)).toEqual(['3:0', '5:0', '5:1', '7:0']);
    expect(beats.at(-1)!.visual).toBeNull();
    expect(beats.at(-1)!.error).toBeTruthy();
    expect(latestUtteranceBeats(beats).map(b => b.key)).toEqual(['7:0']);
  });
});

describe('revealCount', () => {
  const beats = orderBeats([row(3n, 0, array(1, 1)), row(5n, 0, array(2, 3)), row(5n, 1, array(2, 2)), row(5n, 2, array(3, 3))]);
  it('voice: a beat shows when its sentence started, or once its utterance is over (prefix only)', () => {
    const over = (u: bigint) => u === 3n;
    expect(revealCount({ beats, started: new Map(), over, mode: 'voice', textShown: 0 })).toBe(1);
    expect(revealCount({ beats, started: new Map([['5', [0, 2]]]), over, mode: 'voice', textShown: 0 })).toBe(2);
    expect(revealCount({ beats, started: new Map([['5', [0, 1]]]), over, mode: 'voice', textShown: 0 })).toBe(3);
    expect(revealCount({ beats, started: new Map(), over: () => true, mode: 'voice', textShown: 0 })).toBe(4);
  });
  it('text: earlier utterances fully, the latest up to the local cursor', () => {
    expect(revealCount({ beats, started: new Map(), over: () => false, mode: 'typed', textShown: 2 })).toBe(3);
    expect(revealCount({ beats, started: new Map(), over: () => false, mode: 'typed', textShown: 0 })).toBe(1);
  });
  it('reading time follows the team formula and its bounds', () => {
    expect(readingMs('a b')).toBe(2500);
    expect(readingMs(Array(200).fill('w').join(' '))).toBe(15000);
  });
});

describe('BeatCanvasPlayer', () => {
  const beats = orderBeats([row(5n, 0, array(2, 3)), row(5n, 1, array(3, 3)), row(5n, 2, { cues: [{ id: 'c', atMs: 0, commands: [{ type: 'note', text: 'Count them' }] }] })]);
  const visualRows = (p: BeatCanvasPlayer) => (p.director.getSnapshot().canvas.math?.visual as { rows?: number } | undefined)?.rows;
  it('applies the prefix incrementally and rebuilds on replay (shorter prefix)', () => {
    const p = new BeatCanvasPlayer();
    expect(p.sync(beats, 1)).toBe(true);
    expect(visualRows(p)).toBe(2);
    expect(p.sync(beats, 1)).toBe(false);
    p.sync(beats, 3);
    expect(visualRows(p)).toBe(3);
    expect(p.director.getSnapshot().canvas.note).toBe('Count them');
    p.sync(beats, 1);
    expect(visualRows(p)).toBe(2);
    expect(p.director.getSnapshot().canvas.note).toBe('');
    expect(p.error).toBeNull();
  });
  it('falls back to the module canvas_state when a beat cannot apply', () => {
    const broken: OrderedBeat[] = [...beats.slice(0, 1), { ...beats[1]!, key: '5:1', visual: null, error: 'bad json' }];
    const fallback = { ...new BeatCanvasPlayer().director.getSnapshot().canvas, title: 'From the module', note: 'resynced' };
    const p = new BeatCanvasPlayer();
    p.sync(broken, 2, fallback);
    expect(p.error).toBe('bad json');
    expect(p.director.getSnapshot().canvas.note).toBe('resynced');
    expect(parseScene(JSON.stringify(fallback))?.note).toBe('resynced');
    expect(parseScene('{')).toBeNull();
  });
});

describe('small views', () => {
  it('agent status: online only with a fresh heartbeat', () => {
    const now = 1_000_000;
    const row = (ago: number) => ({ id: 0, model: 'claude-haiku-5-5', provider: 'anthropic', busySessions: 1, lastSeen: { microsSinceUnixEpoch: BigInt((now - ago) * 1000) } }) as never;
    expect(agentStatusView(undefined, now).online).toBe(false);
    expect(agentStatusView(row(1000), now)).toMatchObject({ online: true, label: 'Connected to claude-haiku-5-5' });
    expect(agentStatusView(row(AGENT_STALE_MS + 1), now).online).toBe(false);
  });
  it('typed turns show their text, intent-only turns their button label', () => {
    expect(typedTurnText('six', '')).toBe('six');
    expect(typedTurnText('', 'smaller_step')).toBe('Smaller step');
    expect(typedTurnText('[another_way]', 'another_way')).toBe('Show another way');
    expect(typedTurnText('Can you show me another way?', 'another_way')).toBe('Can you show me another way?');
  });
});
