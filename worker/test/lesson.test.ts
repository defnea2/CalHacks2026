// Lesson mode (team streaming planner): moment release timing, repair, recap, deadlines, aborts.
import { describe, expect, it } from 'vitest';
import { emptyCanvas } from '@tutor/teaching/presentation/contracts';
import { buildModelRequest, newLessonRecord } from '@tutor/teaching/teaching/lessonFlow';
import { miniLessonText, miniMeta, miniMoments, miniSession } from '../../teaching/test/fixtures';
import { done, FakeLlm, makeAgent, session, sleep, turn, waitFor, type Step } from './fakes';
import { RECAP_NARRATION } from '../src/lesson';

const A = 1n;
const request = () => buildModelRequest(newLessonRecord(miniSession), emptyCanvas(), 'req');
const text = (delta: string): Step => ({ type: 'text', delta });
function gate() {
  let open!: () => void;
  const p = new Promise<void>(r => (open = r));
  return { p, open };
}
/** The lesson JSON split right after the comma that follows moment `n` (0-based), plus the rest. */
function splitAfterMoment(json: string, n: number): [string, string] {
  let at = -1;
  for (let i = 0; i <= n; i++) at = json.indexOf('},{"visual"', at + 1);
  return [json.slice(0, at + 2), json.slice(at + 2)];
}
function lessonAgent(script: ConstructorParameters<typeof FakeLlm>[0], opts = {}) {
  const llm = new FakeLlm(script);
  const env = makeAgent(llm, undefined, { replyMode: 'lesson', ...opts });
  env.transport.lessonRequest = request();
  return { ...env, llm };
}

describe('lesson mode', () => {
  it('releases each moment as soon as the next comma proves it complete (before the rest is generated)', async () => {
    const g = gate();
    const json = miniLessonText();
    const [head, tail] = splitAfterMoment(json, 0);
    const { agent, transport, llm } = lessonAgent([[text(head), { type: 'wait', until: g.p }, text(tail), done]]);
    agent.onSession(session(A, { voice: false }));
    agent.onTurn({ ...turn(A, 0, 'why is 2/4 one half?'), source: 'text' });
    await waitFor(() => transport.of('addBeat').length === 1, 2000, 'first beat');
    // Moment 0 went out while the model is still generating moment 1.
    expect(transport.of('beginLesson')).toHaveLength(1);
    expect(JSON.parse(String(transport.of('beginLesson')[0]!.meta))).toMatchObject({ phase: 'intuition', check: miniMeta.check });
    expect(transport.of('addBeat')[0]).toMatchObject({ idx: 0, narration: miniMoments[0]!.narration });
    expect(JSON.parse(String(transport.of('addBeat')[0]!.visual))).toEqual({ visual: miniMoments[0]!.visual, interactive: false, showEquation: false });
    expect(transport.of('appendTutorTurn')).toHaveLength(0);
    // The request carried the team system prompt and the module's request, no tools.
    expect(llm.calls[0]!.tools).toEqual([]);
    expect(String(llm.calls[0]!.messages[0]!.content)).toContain('IMPORTANT STREAMING FORMAT');
    expect(String(llm.calls[0]!.messages[1]!.content)).toContain('untrusted lesson data');
    g.open();
    await waitFor(() => transport.of('appendTutorTurn').length === 1);
    const beats = transport.of('addBeat');
    expect(beats.map(b => b.idx)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(beats.slice(0, 5).every(b => !('final' in JSON.parse(String(b.visual))))).toBe(true);
    expect(JSON.parse(String(beats[5]!.visual))).toMatchObject({ final: true, interactive: true });
    expect(transport.of('appendTutorTurn')[0]).toMatchObject({ interrupted: false });
    expect(transport.names().filter(n => !['buildContext', 'buildLessonRequest'].includes(n))[0]).toBe('beginUtterance');
  });

  it('repair round with the validator message when the first output is invalid (nothing spoken yet)', async () => {
    const bad = JSON.stringify({ meta: { ...miniMeta, phase: 'not-a-phase' }, moments: miniMoments });
    const { agent, transport, llm } = lessonAgent([[text(bad), done], [text(miniLessonText()), done]]);
    agent.onSession(session(A, { voice: false }));
    agent.onTurn(turn(A, 0, 'help'));
    await waitFor(() => transport.of('appendTutorTurn').length === 1);
    expect(llm.calls).toHaveLength(2);
    expect(String(llm.calls[1]!.messages[1]!.content)).toMatch(/rejected by the validator: .*phase/s);
    expect(transport.of('addBeat')).toHaveLength(6);
  });

  it('a module rejection of the meta also triggers the repair round', async () => {
    const { agent, transport, llm } = lessonAgent([[text(miniLessonText()), done], [text(miniLessonText()), done]]);
    let calls = 0;
    const base = transport.beginLesson;
    transport.beginLesson = async a => {
      await base(a);
      if (calls++ === 0) throw new Error('Phase is not supported by the current learner evidence: intuition');
    };
    agent.onSession(session(A, { voice: false }));
    agent.onTurn(turn(A, 0, 'help'));
    await waitFor(() => transport.of('appendTutorTurn').length === 1);
    expect(llm.calls).toHaveLength(2);
    expect(String(llm.calls[1]!.messages[1]!.content)).toContain('Phase is not supported');
    expect(transport.of('beginLesson')).toHaveLength(2);
    expect(transport.of('addBeat').map(b => b.idx)).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it('a rejected beat after speech started: truncate and close with a recap carrying the check', async () => {
    const { agent, transport, llm } = lessonAgent([[text(miniLessonText()), done]]);
    const base = transport.addBeat;
    transport.addBeat = async a => {
      await base(a);
      const { idx, visual } = a as { idx: number; visual: string };
      if (idx === 4 && !visual.includes('"final"')) throw new Error('Unknown bar.');
    };
    agent.onSession(session(A, { voice: false }));
    agent.onTurn(turn(A, 0, 'help'));
    await waitFor(() => transport.of('appendTutorTurn').length === 1);
    expect(llm.calls).toHaveLength(1); // no regeneration after speech
    const beats = transport.of('addBeat');
    const last = beats.at(-1)!;
    expect(last).toMatchObject({ idx: 4, narration: RECAP_NARRATION });
    expect(JSON.parse(String(last.visual))).toEqual({ visual: { kind: 'keep' }, interactive: true, showEquation: false, final: true });
    expect(transport.of('appendTutorTurn')[0]!.text).not.toContain(RECAP_NARRATION.slice(0, 0) + 'Return to quarters');
  });

  it('a later moment that fails to compile in the parser also ends with a recap (team dead-stream path)', async () => {
    const moments = structuredClone(miniMoments);
    (moments[3]!.visual as any).changes[0].parts = 99;
    const { agent, transport } = lessonAgent([[text(JSON.stringify({ meta: miniMeta, moments })), done]]);
    agent.onSession(session(A, { voice: false }));
    agent.onTurn(turn(A, 0, 'help'));
    await waitFor(() => transport.of('appendTutorTurn').length === 1);
    const beats = transport.of('addBeat');
    expect(beats.map(b => b.idx)).toEqual([0, 1, 2, 3]);
    expect(beats[3]).toMatchObject({ narration: 'Look at the whole picture once more.' });
  });

  it('no first token within the deadline: the attempt is retried once', async () => {
    const { agent, transport, llm } = lessonAgent([[{ type: 'wait', ms: 400 }, text(miniLessonText()), done], [text(miniLessonText()), done]], {
      lessonDeadlines: { firstTokenMs: 60 },
    });
    agent.onSession(session(A, { voice: false }));
    agent.onTurn(turn(A, 0, 'help'));
    await waitFor(() => transport.of('appendTutorTurn').length === 1);
    expect(llm.calls).toHaveLength(2);
    expect(llm.calls[0]!.signal.aborted).toBe(true);
    expect(transport.of('addBeat')).toHaveLength(6);
  });

  it('stall after the first beat: truncate + recap', async () => {
    const [head] = splitAfterMoment(miniLessonText(), 3);
    const { agent, transport } = lessonAgent([[text(head), { type: 'wait', ms: 2000 }, done]], { lessonDeadlines: { stallMs: 80 } });
    agent.onSession(session(A, { voice: false }));
    agent.onTurn(turn(A, 0, 'help'));
    await waitFor(() => transport.of('appendTutorTurn').length === 1);
    expect(transport.of('addBeat').map(b => b.idx)).toEqual([0, 1, 2, 3, 4]);
    expect(transport.of('addBeat')[4]).toMatchObject({ narration: RECAP_NARRATION });
  });

  it('barge-in and a newer turn abort the stream; nothing more is sent', async () => {
    const g = gate();
    const [head, tail] = splitAfterMoment(miniLessonText(), 1);
    const { agent, transport, llm } = lessonAgent([[text(head), { type: 'wait', until: g.p }, text(tail), done], [text(miniLessonText()), done]]);
    agent.onSession(session(A, { voice: false }));
    agent.onTurn(turn(A, 0, 'help'));
    await waitFor(() => transport.of('addBeat').length === 2);
    agent.onSession(session(A, { voice: false, turnState: 'interrupted' }));
    await waitFor(() => transport.of('appendTutorTurn').length === 1);
    expect(transport.of('appendTutorTurn')[0]).toMatchObject({ interrupted: true });
    expect(llm.calls[0]!.signal.aborted).toBe(true);
    g.open();
    await sleep(20);
    expect(transport.of('addBeat')).toHaveLength(2);
    // A newer turn starts a fresh lesson.
    agent.onTurn(turn(A, 0, 'help', 'done'));
    agent.onTurn(turn(A, 2, 'show me'));
    await waitFor(() => transport.of('appendTutorTurn').length === 2);
    expect(transport.of('addBeat')).toHaveLength(8);
  });

  it('falls back to one authored line when no lesson request can be built', async () => {
    const { agent, transport } = lessonAgent([]);
    transport.lessonRequest = null;
    agent.onSession(session(A, { voice: false }));
    agent.onTurn(turn(A, 0, 'help'));
    await waitFor(() => transport.of('appendTutorTurn').length === 1);
    expect(transport.of('addSentence')).toHaveLength(1);
    expect(transport.of('addBeat')).toHaveLength(0);
  });
});

describe('opening in lesson mode', () => {
  it('stays the authored script (no LLM, no lesson); the first student turn starts the lesson', async () => {
    const { agent, transport, llm } = lessonAgent([[text(miniLessonText()), done]], { verifiedSpeech: true });
    agent.onSession(session(A, { voice: false, turnState: 'thinking' }));
    await waitFor(() => transport.of('appendTutorTurn').length === 1);
    expect(transport.of('beginOpening')).toHaveLength(1);
    expect(transport.of('beginLesson')).toHaveLength(0);
    expect(llm.calls).toHaveLength(0);
    expect(transport.of('addSentence').length).toBeGreaterThan(0);
    agent.onSession(session(A, { voice: false, turnCount: 2 }));
    agent.onTurn(turn(A, 0, '', 'done', 'tutor'));
    agent.onTurn(turn(A, 1, 'why is 2/4 one half?'));
    await waitFor(() => transport.of('appendTutorTurn').length === 2);
    expect(transport.of('beginLesson')).toHaveLength(1);
  });
});

describe('stall watchdog', () => {
  it('a ready turn whose reply never began is answered again once', async () => {
    const llm = new FakeLlm([[text('x'), done]]);
    const { agent, transport, logs } = makeAgent(llm, undefined, { replyMode: 'lesson', stallRetryMs: 60 });
    transport.lessonRequest = request();
    transport.fail.beginUtterance = 'module unreachable';
    agent.onSession(session(A, { voice: false }));
    agent.onTurn(turn(A, 0, 'help'));
    await waitFor(() => transport.of('beginUtterance').length === 2, 2000, 'retry');
    expect(logs.some(l => l.includes('stalled: no utterance'))).toBe(true);
    await sleep(150);
    expect(transport.of('beginUtterance')).toHaveLength(2); // once only
  });
});
