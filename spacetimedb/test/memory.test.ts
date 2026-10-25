import { describe, it, expect } from 'vitest';
import { pack } from '../../shared/src/lesson/index';
import { MODULE_DEFAULTS } from '../../shared/src/config';
import { anthropicResponse, call, chatResponse, llmOk, PROVIDER_ENV, proc, userPrompt, type Provider, makeLearner, makeSession, mod, runExtraction, runSummary, runTts, session, setup, studentSays, ttsSse, type H, type Req } from './helpers';

const cat = pack.taxonomy.find(c => c.concepts.length > 1)!;
const concept = cat.concepts[0]!.key;

/** One student turn + one tutor turn (2 turns). */
function exchange(h: H, env: ReturnType<typeof setup>, sessionId: bigint, utt: bigint, student: string, tutor: string) {
  studentSays(h, env.client, sessionId, student);
  const replyToIdx = session(h, sessionId).turnCount - 1;
  call(h, env.agent, mod.beginUtterance, { sessionId, utteranceId: utt, replyToIdx, preemptive: false });
  call(h, env.agent, mod.addSentence, { sessionId, utteranceId: utt, idx: 0, display: tutor, speech: tutor });
  runTts(h, () => ({ status: 200, body: ttsSse(new Uint8Array(480)) }));
  call(h, env.client, mod.markPlayed, { sessionId, utteranceId: utt, idx: 0 });
  call(h, env.agent, mod.appendTutorTurn, { sessionId, utteranceId: utt, text: tutor, interrupted: false });
}

function start(provider: Provider = 'openrouter', extra: Record<string, string> = {}) {
  const env = setup({ ...PROVIDER_ENV[provider], ...extra }); // MEMORY_EVERY_N_TURNS = 4
  const learner = makeLearner(env.h, env.client);
  const s = makeSession(env.h, env.client, learner.id);
  return { env, h: env.h, learner, s };
}

function item(over: Record<string, unknown> = {}) {
  return {
    action: 'create', noteId: 0, kind: 'strategy', category: cat.key, concept, text: 'Pizza slices make fractions click',
    outcome: 'worked', confidence: 0.9, evidence: { fromTurn: 0, toTurn: 1, quote: 'oh like pizza' }, ...over,
  };
}

describe('extraction scheduling', () => {
  it('schedules a job once N turns are unprocessed', () => {
    const { env, h, s } = start();
    exchange(h, env, s.id, 1n, 'I add the bottoms', 'Let us use pizza.');
    expect([...h.db.extractionJob.iter()]).toHaveLength(0);
    exchange(h, env, s.id, 2n, 'oh like pizza', 'Yes!');
    const jobs = [...h.db.extractionJob.iter()];
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ sessionId: s.id, fromIdx: 0, toIdx: 4, attempt: 0 });
  });
});

describe.each(['openrouter', 'anthropic'] as const)('extractMemory (%s)', provider => {
  it('writes valid notes, evidence and mastery, drops low-confidence and invalid items, advances the cursor', () => {
    const { env, h, s, learner } = start(provider);
    exchange(h, env, s.id, 1n, 'I add the bottoms', 'Let us use pizza.');
    exchange(h, env, s.id, 2n, 'oh like pizza', 'Yes!');
    let req: Req | undefined;
    runExtraction(h, r => {
      req = r;
      return llmOk(provider, {
        items: [
          item(),
          item({ text: 'Maybe likes dogs', confidence: 0.5 }),
          item({ kind: 'favorite_color', text: 'blue' }),
          item({ category: 'cooking', text: 'x' }),
          item({ kind: 'misconception', text: 'Adds the denominators too', outcome: 'unknown', evidence: { fromTurn: 0, toTurn: 0, quote: 'I add the bottoms' } }),
        ],
        mastery: [{ concept, mastery: 40, confidence: 0.8 }, { concept: 'nope', mastery: 90, confidence: 0.9 }],
      });
    });
    const body = JSON.parse(req!.text);
    if (provider === 'openrouter') {
      expect(req!.uri).toBe('https://openrouter.ai/api/v1/chat/completions');
      expect(req!.headers['authorization']).toBe('Bearer openrouter-test');
      expect(body.stream).toBe(false);
      expect(body.model).toBe('test/model');
      expect(body.response_format.type).toBe('json_schema');
    } else {
      expect(req!.uri).toBe('https://api.anthropic.com/v1/messages');
      expect(req!.headers['x-api-key']).toBe('anthropic-test');
      expect(req!.headers['anthropic-version']).toBe('2023-06-01');
      expect(req!.headers['content-type']).toBe('application/json');
      expect(body.model).toBe('claude-haiku-5-5');
      expect(body.max_tokens).toBe(MODULE_DEFAULTS.EXTRACTION_MAX_TOKENS);
      expect(body.output_config).toEqual({ effort: 'medium', format: { type: 'json_schema', schema: expect.any(Object) } });
      expect(body.output_config.format.schema.additionalProperties).toBe(false);
      expect(body.system).toContain('Categories and concepts');
      expect(body.messages).toHaveLength(1);
      for (const k of ['temperature', 'top_p', 'top_k', 'stream', 'thinking']) expect(body).not.toHaveProperty(k);
    }
    expect(userPrompt(provider, req!)).toContain('I add the bottoms');

    const notes = [...h.db.memoryNote.learnerId.filter(learner.id)];
    expect(notes.map(n => n.text).sort()).toEqual(['Adds the denominators too', 'Pizza slices make fractions click']);
    expect([...h.db.noteEvidence.iter()]).toHaveLength(2);
    expect([...h.db.conceptState.learnerId.filter(learner.id)].map(c => [c.concept, c.mastery, c.category])).toEqual([[concept, 40, cat.key]]);
    expect(h.db.extractionCursor.sessionId.find(s.id)!.nextIdx).toBe(4);
  });

  it('prefers update/reinforce: same note is not stored twice; unknown outcome can settle', () => {
    const { env, h, s, learner } = start(provider);
    call(h, env.agent, mod.remember, { sessionId: s.id, kind: 'mnemonic', category: cat.key, concept, text: 'Bottom number = slice size', outcome: 'unknown' });
    const note = [...h.db.memoryNote.learnerId.filter(learner.id)][0]!;
    exchange(h, env, s.id, 1n, 'bottom is slice size', 'Great.');
    exchange(h, env, s.id, 2n, 'so 1/4 is smaller', 'Yes.');
    let prompt = '';
    runExtraction(h, r => {
      prompt = userPrompt(provider, r);
      return llmOk(provider, {
        items: [
          item({ action: 'create', kind: 'mnemonic', text: 'bottom number = slice size!', outcome: 'worked' }), // duplicate create
          item({ action: 'reinforce', noteId: Number(note.id), kind: 'mnemonic', text: 'Bottom number = slice size', outcome: 'worked' }),
        ],
        mastery: [],
      });
    });
    expect(prompt).toContain(`#${note.id} mnemonic`);
    const notes = [...h.db.memoryNote.learnerId.filter(learner.id)];
    expect(notes).toHaveLength(1);
    expect(notes[0]!.reinforced).toBe(2);
    expect(notes[0]!.outcome).toBe('worked');

    // update rewrites the note in place
    exchange(h, env, s.id, 3n, 'a', 'b');
    exchange(h, env, s.id, 4n, 'c', 'd');
    runExtraction(h, () => llmOk(provider, { items: [item({ action: 'update', noteId: Number(note.id), kind: 'mnemonic', text: 'Uses slice-size rule unprompted' })], mastery: [] }));
    const after = [...h.db.memoryNote.learnerId.filter(learner.id)];
    expect(after).toHaveLength(1);
    expect(after[0]!.text).toBe('Uses slice-size rule unprompted');
  });

  it('cursor race: a run whose window was handled meanwhile writes nothing', () => {
    const { env, h, s, learner } = start(provider);
    exchange(h, env, s.id, 1n, 'one', 'two');
    exchange(h, env, s.id, 2n, 'three', 'four');
    runExtraction(h, (_r, hh) => {
      // Another run finishes the same window while this one waits on the LLM.
      hh.withReducerTx(env.agent, ctx => {
        const c = ctx.db.extractionCursor.sessionId.find(s.id)!;
        ctx.db.extractionCursor.sessionId.update({ ...c, nextIdx: 4 });
      });
      return llmOk(provider, { items: [item()], mastery: [{ concept, mastery: 70, confidence: 0.9 }] });
    });
    expect([...h.db.memoryNote.learnerId.filter(learner.id)]).toHaveLength(0);
    expect([...h.db.conceptState.iter()]).toHaveLength(0);

    // A stale job (cursor already past its start) stops before calling the LLM.
    h.withReducerTx(env.agent, ctx =>
      ctx.db.extractionJob.insert({ scheduledId: 0n, scheduledAt: { tag: 'Time', value: ctx.timestamp } as never, sessionId: s.id, learnerId: learner.id, fromIdx: 0, toIdx: 4, attempt: 0 })
    );
    expect(runExtraction(h)).toBe(1); // no responder: an HTTP call would throw
  });

  it('retries after 10/30/90 s on HTTP errors, then stops', () => {
    const { env, h, s } = start(provider);
    exchange(h, env, s.id, 1n, 'one', 'two');
    exchange(h, env, s.id, 2n, 'three', 'four');
    const delays: number[] = [];
    for (let i = 0; i < 4; i++) {
      const now = h.clock.now().microsSinceUnixEpoch;
      runExtraction(h, () => ({ status: 502, body: 'bad gateway' }));
      const jobs = [...h.db.extractionJob.iter()];
      if (i < 3) {
        expect(jobs).toHaveLength(1);
        expect(jobs[0]!.attempt).toBe(i + 1);
        const at = (jobs[0]!.scheduledAt as unknown as { value: { microsSinceUnixEpoch: bigint } }).value.microsSinceUnixEpoch;
        delays.push(Number((at - now) / 1_000_000n));
      } else {
        expect(jobs).toHaveLength(0);
      }
    }
    expect(delays).toEqual([...MODULE_DEFAULTS.EXTRACTION_RETRY_S]);
    expect(h.db.extractionCursor.sessionId.find(s.id)!.nextIdx).toBe(0);
  });

  it('malformed LLM JSON counts as an HTTP-level failure and is retried', () => {
    const { env, h, s } = start(provider);
    exchange(h, env, s.id, 1n, 'one', 'two');
    exchange(h, env, s.id, 2n, 'three', 'four');
    runExtraction(h, () =>
      provider === 'anthropic'
        ? anthropicResponse(null, { text: '{"items": [' })
        : { status: 200, body: JSON.stringify({ choices: [{ message: { content: 'not json' } }] }) }
    );
    expect([...h.db.extractionJob.iter()][0]!.attempt).toBe(1);
  });
});

describe('anthropic provider', () => {
  function window(extra: Record<string, string> = {}) {
    const st = start('anthropic', extra);
    exchange(st.h, st.env, st.s.id, 1n, 'I add the bottoms', 'Let us use pizza.');
    exchange(st.h, st.env, st.s.id, 2n, 'oh like pizza', 'Yes!');
    return st;
  }

  it('reads the text block after a leading thinking block', () => {
    const { h, s, learner } = window();
    runExtraction(h, () => anthropicResponse({ items: [item()], mastery: [] }));
    expect([...h.db.memoryNote.learnerId.filter(learner.id)].map(n => n.text)).toEqual(['Pizza slices make fractions click']);
    expect(h.db.extractionCursor.sessionId.find(s.id)!.nextIdx).toBe(4);
  });

  it('refusal skips the window: no retry, nothing written, cursor advances', () => {
    const { h, s, learner } = window();
    runExtraction(h, () => anthropicResponse(null, { stopReason: 'refusal', text: '', stopDetails: { type: 'refusal', category: null, explanation: 'x' } }));
    expect([...h.db.extractionJob.iter()]).toHaveLength(0);
    expect([...h.db.memoryNote.learnerId.filter(learner.id)]).toHaveLength(0);
    expect(h.db.extractionCursor.sessionId.find(s.id)!.nextIdx).toBe(4);
  });

  it('max_tokens is a failure and is retried', () => {
    const { h, s } = window();
    runExtraction(h, () => anthropicResponse(null, { stopReason: 'max_tokens', text: '{"items": [{"act' }));
    expect([...h.db.extractionJob.iter()].map(j => j.attempt)).toEqual([1]);
    expect(h.db.extractionCursor.sessionId.find(s.id)?.nextIdx ?? 0).toBe(0);
  });

  it('HTTP 5xx schedules retries after 10/30/90 s', () => {
    const { h } = window();
    const delays: number[] = [];
    for (let i = 0; i < 3; i++) {
      const now = h.clock.now().microsSinceUnixEpoch;
      runExtraction(h, () => ({ status: 529, body: JSON.stringify({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }) }));
      const job = [...h.db.extractionJob.iter()][0]!;
      delays.push(Number(((job.scheduledAt as unknown as { value: { microsSinceUnixEpoch: bigint } }).value.microsSinceUnixEpoch - now) / 1_000_000n));
    }
    expect(delays).toEqual([...MODULE_DEFAULTS.EXTRACTION_RETRY_S]);
  });

  it('MEMORY_PROVIDER=openrouter overrides a present ANTHROPIC_API_KEY; ANTHROPIC_EXTRACTION_MODEL overrides the model', () => {
    let uri = '';
    const a = window({ MEMORY_PROVIDER: 'openrouter' });
    runExtraction(a.h, r => ((uri = r.uri), chatResponse({ items: [], mastery: [] })));
    expect(uri).toBe('https://openrouter.ai/api/v1/chat/completions');
    let model = '';
    const b = window({ ANTHROPIC_EXTRACTION_MODEL: 'claude-sonnet-5-5' });
    runExtraction(b.h, r => ((model = JSON.parse(r.text).model), anthropicResponse({ items: [], mastery: [] })));
    expect(model).toBe('claude-sonnet-5-5');
  });

  it('session summary uses low effort; refusal is not retried', () => {
    const { env, h, s } = window();
    call(h, env.client, mod.endSession, { sessionId: s.id });
    runExtraction(h, () => anthropicResponse({ items: [], mastery: [] }));
    let body: any;
    runSummary(h, r => ((body = JSON.parse(r.text)), anthropicResponse({ summary: 'Pizza fractions.', nextFocus: 'Unlike denominators' })));
    expect(body.output_config.effort).toBe('low');
    expect(h.db.sessionSummary.sessionId.find(s.id)!.summary).toBe('Pizza fractions.');

    const s2 = makeSession(h, env.client, [...h.db.learner.iter()][0]!.id);
    exchange(h, env, s2.id, 3n, 'x', 'y');
    call(h, env.client, mod.endSession, { sessionId: s2.id });
    runExtraction(h, () => anthropicResponse({ items: [], mastery: [] }));
    runSummary(h, () => anthropicResponse(null, { stopReason: 'refusal', text: '' }));
    expect([...h.db.summaryJob.iter()]).toHaveLength(0);
    expect(h.db.sessionSummary.sessionId.find(s2.id) ?? undefined).toBeUndefined();
  });
});

describe('endSession', () => {
  it('schedules a final extraction for leftover turns and a summary', () => {
    const { env, h, s, learner } = start();
    exchange(h, env, s.id, 1n, 'one', 'two');
    call(h, env.client, mod.endSession, { sessionId: s.id });
    expect(session(h, s.id).active).toBe(false);
    expect([...h.db.extractionJob.iter()].map(j => [j.fromIdx, j.toIdx])).toEqual([[0, 2]]);
    runExtraction(h, () => chatResponse({ items: [], mastery: [] }));
    expect(h.db.extractionCursor.sessionId.find(s.id)!.nextIdx).toBe(2);
    runSummary(h, () => chatResponse({ summary: 'Worked on expanding fractions.', nextFocus: 'Finding k' }));
    expect(h.db.sessionSummary.sessionId.find(s.id)).toMatchObject({ learnerId: learner.id, summary: 'Worked on expanding fractions.', nextFocus: 'Finding k' });

    // The next session's context carries the summary.
    const s2 = makeSession(h, env.client, learner.id);
    const ctxText: string = (mod.buildContext as any)(proc(h, env.agent), { sessionId: s2.id });
    expect(ctxText).toContain('Worked on expanding fractions.');
  });
});
