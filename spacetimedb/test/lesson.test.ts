import { describe, it, expect } from 'vitest';
import { pack } from '../../shared/src/lesson/index';
import { canTransition } from '../../shared/src/lesson/api';
import { GAP_MAX_ATTEMPTS } from '../src/lesson';
import { call, makeLearner, makeSession, mod, proc, session, setup, studentSays } from './helpers';

// Kinds/phases are taken from the pack by shape, never by name.
const answerable = pack.boardKinds.find(k => /expectedAnswer/.test(k.description))!;
const plain = pack.boardKinds.find(k => k.contentSchema.required?.length === 1 && k.contentSchema.properties?.[k.contentSchema.required[0]!]?.type === 'string' && !/expectedAnswer/.test(k.description))!;
const stepKind = pack.boardKinds.find(k => k.contentSchema.properties?.steps?.type === 'array')!;

function start() {
  const env = setup();
  const learner = makeLearner(env.h, env.client);
  const s = makeSession(env.h, env.client, learner.id);
  return { ...env, learner, s };
}

const show = (args: Partial<{ kind: string; content: string; taskKey: string; expectedAnswer: string }>) => ({
  utteranceId: 0n,
  sentenceIdx: 0,
  markerPos: -1,
  kind: '',
  content: '',
  taskKey: '',
  expectedAnswer: '',
  ...args,
});

describe('phases', () => {
  it('starts in the pack initial phase and only allows pack transitions', () => {
    const { h, agent, client, s } = start();
    expect(session(h, s.id).phase).toBe(pack.initialPhase);
    expect(s.packVersion).toBe(pack.version);
    const from = pack.initialPhase;
    const allowed = pack.phases.find(p => canTransition(pack, from, p.id) && p.id !== from)!;
    const forbidden = pack.phases.find(p => !canTransition(pack, allowed.id, p.id));
    expect(() => call(h, client, mod.setPhase, { sessionId: s.id, phase: allowed.id, reason: 'x' })).toThrow(/agent only/);
    call(h, agent, mod.setPhase, { sessionId: s.id, phase: allowed.id, reason: 'ready' });
    expect(session(h, s.id).phase).toBe(allowed.id);
    if (forbidden) {
      expect(() => call(h, agent, mod.setPhase, { sessionId: s.id, phase: forbidden.id, reason: 'x' })).toThrow(/cannot move/);
      expect(session(h, s.id).phase).toBe(allowed.id);
    }
    expect(() => call(h, agent, mod.setPhase, { sessionId: s.id, phase: 'no-such-phase', reason: 'x' })).toThrow(/unknown phase/);
  });

  it('nothing follows the final phase', () => {
    const { h, agent, s } = start();
    call(h, agent, mod.setPhase, { sessionId: s.id, phase: pack.finalPhase, reason: 'hand back' });
    for (const p of pack.phases.filter(p => p.id !== pack.finalPhase)) {
      expect(() => call(h, agent, mod.setPhase, { sessionId: s.id, phase: p.id, reason: 'x' })).toThrow(/cannot move/);
    }
  });
});

describe('board', () => {
  it('validates kind, schema and size', () => {
    const { h, agent, s } = start();
    expect(() => call(h, agent, mod.showBoardItem, { sessionId: s.id, ...show({ kind: 'nope', content: '{}' }) })).toThrow(/unknown board kind/);
    expect(() => call(h, agent, mod.showBoardItem, { sessionId: s.id, ...show({ kind: plain.name, content: '{}' }) })).toThrow(/invalid content/);
    expect(() => call(h, agent, mod.showBoardItem, { sessionId: s.id, ...show({ kind: plain.name, content: 'not json' }) })).toThrow(/JSON/);
    const big = JSON.stringify({ [plain.contentSchema.required![0]!]: 'x'.repeat(5000) });
    expect(() => call(h, agent, mod.showBoardItem, { sessionId: s.id, ...show({ kind: plain.name, content: big }) })).toThrow(/too large/);
    const ok = JSON.stringify({ [plain.contentSchema.required![0]!]: 'hello' });
    call(h, agent, mod.showBoardItem, { sessionId: s.id, ...show({ kind: plain.name, content: ok }), utteranceId: 5n, sentenceIdx: 2 });
    const [item] = [...h.db.boardItem.sessionId.filter(s.id)];
    expect(item).toMatchObject({ kind: plain.name, visible: true, utteranceId: 5n, sentenceIdx: 2, answerState: '', phase: pack.initialPhase, idx: 0 });
    call(h, agent, mod.clearBoard, { sessionId: s.id });
    expect([...h.db.boardItem.sessionId.filter(s.id)][0]!.visible).toBe(false);
  });

  it('stores sentence-tagged animated math and rejects invalid command shapes', () => {
    const { h, agent, s } = start();
    const kind = pack.boardKinds.find(k => k.contentSchema.properties?.moments)!.name;
    const content = { title: 'Stretch the rectangle', moments: [
      { sentenceOffset: 0, visual: { kind: 'geometry', shape: 'rectangle', width: 3, height: 2 } },
      { sentenceOffset: 1, visual: { kind: 'update', changes: [{ type: 'set_geometry', width: 6 }] } },
    ] };
    call(h, agent, mod.showBoardItem, { sessionId: s.id, ...show({ kind, content: JSON.stringify(content) }), utteranceId: 7n, sentenceIdx: 1 });
    expect([...h.db.boardItem.sessionId.filter(s.id)][0]).toMatchObject({ utteranceId: 7n, sentenceIdx: 1, kind });
    const bad = { ...content, moments: [{ sentenceOffset: 0, visual: { kind: 'geometry', shape: 'rectangle', width: 3.2, height: 2 } }] };
    expect(() => call(h, agent, mod.showBoardItem, { sessionId: s.id, ...show({ kind, content: JSON.stringify(bad) }) })).toThrow(/invalid content/);
  });

  it('stores the inline-marker reveal anchor, validated against the tagged sentence', () => {
    const { h, agent, client, s } = start();
    studentSays(h, client, s.id, 'help');
    call(h, agent, mod.beginUtterance, { sessionId: s.id, utteranceId: 9n, replyToIdx: 0, preemptive: false });
    call(h, agent, mod.addSentence, { sessionId: s.id, utteranceId: 9n, idx: 0, display: 'Here are two thirds.', speech: 'Here are two thirds.' });
    const ok = JSON.stringify({ [plain.contentSchema.required![0]!]: 'hello' });
    const items = () => [...h.db.boardItem.sessionId.filter(s.id)].sort((a, b) => a.idx - b.idx);
    // anchored at "two"
    call(h, agent, mod.showBoardItem, { sessionId: s.id, ...show({ kind: plain.name, content: ok }), utteranceId: 9n, sentenceIdx: 0, markerPos: 9 });
    // past the end: clamped to the speech length
    call(h, agent, mod.showBoardItem, { sessionId: s.id, ...show({ kind: plain.name, content: ok }), utteranceId: 9n, sentenceIdx: 0, markerPos: 500 });
    // sentence that does not exist: falls back to the sentence-start reveal
    call(h, agent, mod.showBoardItem, { sessionId: s.id, ...show({ kind: plain.name, content: ok }), utteranceId: 9n, sentenceIdx: 4, markerPos: 3 });
    // no marker
    call(h, agent, mod.showBoardItem, { sessionId: s.id, ...show({ kind: plain.name, content: ok }), utteranceId: 9n, sentenceIdx: 1 });
    expect(items().map(i => [i.sentenceIdx, i.markerPos])).toEqual([
      [0, 9],
      [0, 'Here are two thirds.'.length],
      [4, -1],
      [1, -1],
    ]);
    expect(() =>
      call(h, agent, mod.showBoardItem, { sessionId: s.id, ...show({ kind: plain.name, content: ok }), utteranceId: 9n, sentenceIdx: 0, markerPos: -2 })
    ).toThrow(/markerPos/);
  });

  it('gap tasks need an expected answer; submitGapAnswer checks deterministically', () => {
    const { h, agent, client, s } = start();
    const content = JSON.stringify({ latex: '\\frac{1}{2} = \\frac{\\square}{6}', prompt: 'Fill the box' });
    expect(() => call(h, agent, mod.showBoardItem, { sessionId: s.id, ...show({ kind: answerable.name, content }) })).toThrow(/expectedAnswer/);
    expect(() =>
      call(h, agent, mod.showBoardItem, { sessionId: s.id, ...show({ kind: answerable.name, content, expectedAnswer: '{"form":"blob","value":"3"}' }) })
    ).toThrow(/form/);
    call(h, agent, mod.showBoardItem, { sessionId: s.id, ...show({ kind: answerable.name, content, expectedAnswer: '{"form":"number","value":"3"}' }) });
    const item = [...h.db.boardItem.sessionId.filter(s.id)][0]!;
    expect(item.answerState).toBe('open');
    expect(JSON.parse(h.db.boardAnswer.boardItemId.find(item.id)!.answer)).toEqual({ form: 'number', value: '3' });
    expect(item.content).not.toContain('"3"');

    call(h, client, mod.submitGapAnswer, { boardItemId: item.id, answer: 'four' });
    expect(h.db.boardItem.id.find(item.id)!).toMatchObject({ answerState: 'wrong', lastAnswer: 'four' });
    call(h, client, mod.submitGapAnswer, { boardItemId: item.id, answer: 'three' });
    expect(h.db.boardItem.id.find(item.id)!.answerState).toBe('correct');
  });

  it('submitGapAnswer: only in an active session, stops after GAP_MAX_ATTEMPTS, a solved task is not re-graded', () => {
    const { h, agent, client, s } = start();
    const content = JSON.stringify({ latex: '\\frac{1}{2} = \\frac{\\square}{6}' });
    call(h, agent, mod.showBoardItem, { sessionId: s.id, ...show({ kind: answerable.name, content, expectedAnswer: '{"form":"number","value":"3"}' }) });
    const item = [...h.db.boardItem.sessionId.filter(s.id)][0]!;
    for (let i = 0; i < GAP_MAX_ATTEMPTS; i++) call(h, client, mod.submitGapAnswer, { boardItemId: item.id, answer: String(10 + i) });
    expect(h.db.boardItem.id.find(item.id)!).toMatchObject({ answerState: 'wrong', attempts: GAP_MAX_ATTEMPTS });
    expect(() => call(h, client, mod.submitGapAnswer, { boardItemId: item.id, answer: '3' })).toThrow(/no more answers/);

    call(h, agent, mod.showBoardItem, { sessionId: s.id, ...show({ kind: answerable.name, content, expectedAnswer: '{"form":"number","value":"3"}' }) });
    const second = [...h.db.boardItem.sessionId.filter(s.id)].find(b => b.id !== item.id)!;
    call(h, client, mod.submitGapAnswer, { boardItemId: second.id, answer: '3' });
    call(h, client, mod.submitGapAnswer, { boardItemId: second.id, answer: '4' });
    expect(h.db.boardItem.id.find(second.id)!).toMatchObject({ answerState: 'correct', lastAnswer: '3', attempts: 1 });

    call(h, client, mod.endSession, { sessionId: s.id });
    expect(() => call(h, client, mod.submitGapAnswer, { boardItemId: second.id, answer: '3' })).toThrow(/ended/);
  });

  it('fraction answers must match in form', () => {
    const { h, agent, client, s } = start();
    const content = JSON.stringify({ latex: '\\frac{1}{2} = \\square' });
    call(h, agent, mod.showBoardItem, { sessionId: s.id, ...show({ kind: answerable.name, content, expectedAnswer: '{"form":"fraction","value":"3/6"}' }) });
    const item = [...h.db.boardItem.sessionId.filter(s.id)][0]!;
    call(h, client, mod.submitGapAnswer, { boardItemId: item.id, answer: '1/2' });
    expect(h.db.boardItem.id.find(item.id)!.answerState).toBe('wrong');
    call(h, client, mod.submitGapAnswer, { boardItemId: item.id, answer: '3 over 6' });
    expect(h.db.boardItem.id.find(item.id)!.answerState).toBe('correct');
  });

  it('resolves library tasks by taskKey, with the answer kept private', () => {
    const { h, agent, client, s } = start();
    h.withReducerTx(agent, ctx => {
      ctx.db.task.insert({
        key: 't-gap', skill: 'k/s1', concept: 'fractions-expand', type: 'gap', difficulty: 1,
        show: '\\frac{1}{2} = \\frac{\\square}{6}', say: 'One half is how many sixths?',
        answer: JSON.stringify({ form: 'number', value: '3' }), steps: '[]', wrongStepIndex: -1,
      });
      ctx.db.task.insert({
        key: 't-we', skill: 'k/s1', concept: 'fractions-expand', type: 'worked_example', difficulty: 1,
        show: '\\frac{3}{5} \\to k = 4', say: 'Expand three fifths by four.',
        answer: JSON.stringify({ form: 'fraction', value: '12/20' }),
        steps: JSON.stringify([{ show: '\\frac{3 \\cdot 4}{5 \\cdot 4}', say: 'Multiply top and bottom by four.' }, { show: '\\frac{12}{20}', say: 'Twelve twentieths.' }]),
        wrongStepIndex: -1,
      });
    });
    expect(() => call(h, agent, mod.showBoardItem, { sessionId: s.id, ...show({ taskKey: 'missing' }) })).toThrow(/unknown taskKey/);
    call(h, agent, mod.showBoardItem, { sessionId: s.id, ...show({ taskKey: 't-gap' }) });
    call(h, agent, mod.showBoardItem, { sessionId: s.id, ...show({ taskKey: 't-we' }) });
    const items = [...h.db.boardItem.sessionId.filter(s.id)].sort((a, b) => a.idx - b.idx);
    expect(items[0]!.kind).toBe(answerable.name);
    expect(JSON.parse(items[0]!.content).latex).toContain('\\square');
    expect(items[0]!.taskKey).toBe('t-gap');
    expect(items[0]!.answerState).toBe('open');
    expect(items[1]!.kind).toBe(stepKind.name);
    expect(JSON.parse(items[1]!.content).steps).toHaveLength(2);
    call(h, client, mod.submitGapAnswer, { boardItemId: items[0]!.id, answer: '3' });
    expect(h.db.boardItem.id.find(items[0]!.id)!.answerState).toBe('correct');
  });
});

describe('set_topic and context', () => {
  it('validates the topic, stores it and returns material + notes', () => {
    const { h, agent, client, s, learner } = start();
    const cat = pack.taxonomy.find(c => c.concepts.length > 1)!;
    const other = pack.taxonomy.find(c => c.key !== cat.key)!;
    expect(() => (mod.setTopic as any)(proc(h, client), { sessionId: s.id, category: cat.key, concept: '' })).toThrow(/agent only/);
    let r = JSON.parse((mod.setTopic as any)(proc(h, agent), { sessionId: s.id, category: 'nope', concept: '' }));
    expect(r.ok).toBe(false);
    r = JSON.parse((mod.setTopic as any)(proc(h, agent), { sessionId: s.id, category: cat.key, concept: other.concepts[0]!.key }));
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/not in/);

    call(h, agent, mod.remember, { sessionId: s.id, kind: 'strategy', category: cat.key, concept: cat.concepts[0]!.key, text: 'Pizza slices help', outcome: 'worked' });
    call(h, agent, mod.remember, { sessionId: s.id, kind: 'preference', category: other.key, concept: '', text: 'Likes short hints', outcome: 'unknown' });
    r = JSON.parse((mod.setTopic as any)(proc(h, agent), { sessionId: s.id, category: cat.key, concept: cat.concepts[0]!.key }));
    expect(r.ok).toBe(true);
    expect(r.material.concepts.map((c: { key: string }) => c.key)).toEqual(cat.concepts.map(c => c.key));
    expect(r.material.concept.key).toBe(cat.concepts[0]!.key);
    expect(r.notes.notes.map((n: { text: string }) => n.text)).toEqual(['Pizza slices help']);
    expect(session(h, s.id)).toMatchObject({ category: cat.key, concept: cat.concepts[0]!.key });

    const text: string = (mod.buildContext as any)(proc(h, agent), { sessionId: s.id });
    expect(text).toContain(learner.name);
    expect(text).toContain('short hints, pictures');
    expect(text).toContain('Expand 2/3 to twelfths');
    expect(text).toContain(pack.initialPhase);
    expect(text).toContain('Pizza slices help');
    expect(text).toContain('Likes short hints'); // preference notes always
    expect(text).toContain('Library material');
    expect(text).not.toContain('{{');
  });

  it('getSessionImage returns a data URL', () => {
    const { h, agent, client, s } = start();
    expect((mod.getSessionImage as any)(proc(h, agent), { sessionId: s.id })).toBe('');
    call(h, client, mod.uploadPhoto, { sessionId: s.id, mime: 'image/png', data: new Uint8Array([1, 2, 3, 4]) });
    expect(session(h, s.id).hasImage).toBe(true);
    expect((mod.getSessionImage as any)(proc(h, agent), { sessionId: s.id })).toBe('data:image/png;base64,AQIDBA==');
    expect(() => call(h, client, mod.uploadPhoto, { sessionId: s.id, mime: 'image/png', data: new Uint8Array(1_000_001) })).toThrow(/too large/);
  });
});

describe('sessions', () => {
  it('startSession ends the previous active session and schedules its summary', () => {
    const { h, client, s, learner } = start();
    const s2 = makeSession(h, client, learner.id, 'second');
    expect(session(h, s.id).active).toBe(false);
    expect(session(h, s.id).endedAt).toBeTruthy();
    expect(s2.id).not.toBe(s.id);
    expect(s2.code).toMatch(/^[A-Z0-9]{4}$/);
    expect([...h.db.summaryJob.iter()].map(j => j.sessionId)).toEqual([s.id]);
  });
});
