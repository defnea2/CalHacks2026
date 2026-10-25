import { describe, expect, it } from 'vitest';
import { buildToolSpecs, pack, TOOL_NAMES } from '@tutor/shared';
import { ToolRouter } from '../src/router';
import { createToolDefs } from '../src/tools/index';
import type { ToolModule } from '../src/tools/types';
import { FakeTransport, sleep } from './fakes';

const ctx = (transport: FakeTransport) => ({ sessionId: 7n, utteranceId: 99n, nextSentenceIdx: 3, transport });
const call = (name: string, args: unknown) => ({ id: 'c1', name, arguments: typeof args === 'string' ? args : JSON.stringify(args) });
const kindName = pack.boardKinds[0]!.name;
const phaseId = pack.phases[1]!.id;

describe('tool registry', () => {
  it('offers every pack tool spec with a handler, kinds set', () => {
    const defs = createToolDefs(pack);
    expect(defs.map(d => d.name)).toEqual(buildToolSpecs(pack).map(s => s.name));
    expect(defs.find(d => d.name === TOOL_NAMES.setTopic)!.kind).toBe('query');
    for (const n of [TOOL_NAMES.setPhase, TOOL_NAMES.showBoardItem, TOOL_NAMES.clearBoard, TOOL_NAMES.remember]) {
      expect(defs.find(d => d.name === n)!.kind).toBe('action');
    }
  });

  it('adding a tool module + spec needs nothing else', async () => {
    const extra: ToolModule = { name: 'ping', kind: 'action', handler: async () => 'pong' };
    const specs = [...buildToolSpecs(pack), { name: 'ping', description: 'Ping.', parameters: { type: 'object', properties: {} } }];
    const router = new ToolRouter(createToolDefs(pack, [...createToolDefs(pack), extra], specs), 100);
    expect(router.specs().map(s => s.name)).toContain('ping');
    expect((await router.run(call('ping', {}), ctx(new FakeTransport()))).result).toBe('pong');
  });
});

describe('ToolRouter', () => {
  const t = () => new FakeTransport();

  it('runs action tools and returns ok', async () => {
    const tr = t();
    const r = await new ToolRouter(createToolDefs(pack), 100).run(call(TOOL_NAMES.setPhase, { phase: phaseId, reason: 'ready' }), ctx(tr));
    expect(r).toMatchObject({ ok: true, result: 'ok', kind: 'action' });
    expect(tr.of('setPhase')).toEqual([{ sessionId: 7n, phase: phaseId, reason: 'ready' }]);
  });

  it('show_board_item: content as JSON string, tagged with utterance and next sentence', async () => {
    const tr = t();
    const content = { text: 'Hello' };
    const ans = { form: 'number', value: '3' };
    await new ToolRouter(createToolDefs(pack), 100).run(call(TOOL_NAMES.showBoardItem, { kind: kindName, content, expectedAnswer: ans }), ctx(tr));
    expect(tr.of('showBoardItem')).toEqual([
      { sessionId: 7n, utteranceId: 99n, sentenceIdx: 3, markerPos: -1, kind: kindName, content: JSON.stringify(content), taskKey: '', expectedAnswer: JSON.stringify(ans) },
    ]);
    await new ToolRouter(createToolDefs(pack), 100).run(call(TOOL_NAMES.showBoardItem, { kind: kindName, taskKey: 'k1' }), ctx(tr));
    expect(tr.of('showBoardItem')[1]).toMatchObject({ content: '', taskKey: 'k1', expectedAnswer: '' });
  });

  it('show_board_item with an id uses the marker anchor; unknown ids fall back to the next sentence', async () => {
    const tr = t();
    const asked: unknown[] = [];
    const anchor = (id: unknown) => (asked.push(id), id === 'b1' ? { sentenceIdx: 1, pos: 12 } : undefined);
    const router = new ToolRouter(createToolDefs(pack), 100);
    await router.run(call(TOOL_NAMES.showBoardItem, { id: 'b1', kind: kindName, content: { text: 'a' } }), { ...ctx(tr), anchor });
    await router.run(call(TOOL_NAMES.showBoardItem, { id: 'zz', kind: kindName, content: { text: 'b' } }), { ...ctx(tr), anchor });
    expect(asked).toEqual(['b1', 'zz']);
    expect(tr.of('showBoardItem').map(a => [a.sentenceIdx, a.markerPos])).toEqual([
      [1, 12],
      [3, -1],
    ]);
  });

  it('query tools return the procedure result', async () => {
    const tr = t();
    const r = await new ToolRouter(createToolDefs(pack), 100).run(call(TOOL_NAMES.setTopic, { category: pack.taxonomy[0]!.key }), ctx(tr));
    expect(r).toMatchObject({ ok: true, kind: 'query', result: tr.topicResult });
    expect(tr.of('setTopic')[0]).toEqual({ sessionId: 7n, category: pack.taxonomy[0]!.key, concept: '' });
  });

  it('rejects arguments that violate the tool schema before running the handler', async () => {
    const tr = new FakeTransport();
    const router = new ToolRouter(createToolDefs(pack), 200);
    const missing = await router.run(call(TOOL_NAMES.setPhase, { reason: 'no phase given' }), ctx(tr));
    expect(missing.ok).toBe(false);
    expect(missing.result).toMatch(/^error: invalid arguments: .*phase.*required/);
    const badEnum = await router.run(call(TOOL_NAMES.setPhase, { phase: 'not-a-phase', reason: 'x' }), ctx(tr));
    expect(badEnum.result).toMatch(/^error: invalid arguments: .*must be one of/);
    expect(tr.of('setPhase')).toEqual([]);
  });

  it('errors never throw: reducer error, bad JSON, unknown tool, timeout', async () => {
    const tr = t();
    tr.fail.setPhase = 'transition not allowed';
    const router = new ToolRouter(createToolDefs(pack), 50);
    expect((await router.run(call(TOOL_NAMES.setPhase, { phase: phaseId, reason: '' }), ctx(tr))).result).toBe('error: transition not allowed');
    expect((await router.run(call(TOOL_NAMES.setPhase, '{"phase":'), ctx(tr))).result).toMatch(/^error: invalid arguments/);
    expect((await router.run(call(TOOL_NAMES.setPhase, '[1]'), ctx(tr))).result).toMatch(/^error: invalid arguments/);
    expect((await router.run(call('nope', {}), ctx(tr))).result).toBe('error: unknown tool nope');
    tr.delayMs.clearBoard = 200;
    const r = await router.run(call(TOOL_NAMES.clearBoard, ''), ctx(tr));
    expect(r).toMatchObject({ ok: false, result: 'error: timed out after 50 ms' });
    await sleep(160);
  });
});
