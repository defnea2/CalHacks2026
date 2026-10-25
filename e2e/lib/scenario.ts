// Runs one scenario end to end and evaluates it.
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from 'puppeteer-core';
import { OPENING_TURN_IDX, pack } from '@tutor/shared';
import { launch, tid } from './browser';
import { FIXTURES } from './env';
import { readSession, type ServerSession, type TurnMetric } from './server';
import { wordRecall } from './text';
import { createSessionViaUi, startTalking } from './ui';
import { E2E_DEFAULTS, TASK_TEXT, type Scenario } from '../scenarios';

export type CheckStatus = 'pass' | 'fail' | 'warn' | 'skip';
export interface Check {
  name: string;
  status: CheckStatus;
  detail: string;
}

type Ev = { t: number; wall: number; type: string; [k: string]: unknown };

interface PageState {
  phase: string;
  turnState: string;
  noise: string;
  tutorAudio: boolean;
  phrases: { phraseId: number; turnIdx: number; status: string; text: string }[];
  sentences: { utteranceId: string; idx: number; status: string; display: string }[];
  boardItems: { id: string; idx: number; kind: string; visible: boolean; utteranceId: string; sentenceIdx?: number; markerPos?: number }[];
  localLatencyMs: number[];
}

interface DomSnapshot {
  phase: string | null;
  phaseText: string;
  noise: string | null;
  mathBoard: { canvas: boolean; error: boolean } | null;
  board: { id: string; kind: string; revealed: boolean; known: boolean; fallback: boolean; empty: boolean }[];
  tutorCaptions: { utteranceId: string; idx: string; status: string; text: string }[];
  studentCaptions: { phraseId: string; text: string }[];
}

interface ObserverSample {
  wall: number;
  phase: string | null;
  tutor: { utteranceId: string; idx: string; text: string }[];
  student: string[];
}

export interface ScenarioRun {
  id: string;
  fixture: string;
  attempt: number;
  status: 'pass' | 'fail' | 'external';
  sessionId: string;
  learnerName: string;
  durationMs: number;
  checks: Check[];
  metrics: TurnMetric[];
  localLatencyMs: number[];
  transcript: string;
  sourceText: string;
  externalEvidence: string[];
  error?: string;
  /** Raw data for cross-session checks (not written to the report). */
  page?: PageState;
  server?: ServerSession;
}

export interface Fixture {
  name: string;
  text: string;
  timeline: { say: string; startMs: number; endMs: number }[];
  durationMs: number;
}

export function loadFixture(name: string): Fixture {
  return JSON.parse(fs.readFileSync(path.join(FIXTURES, `${name}.json`), 'utf8'));
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const DONE_SENTENCE = new Set(['played', 'dropped']);

/** Utterance id of the tutor's opening reply ('' if none). */
export const openingUtterance = (srv: ServerSession) => srv.metrics.find(m => m.turnIdx === OPENING_TURN_IDX && m.utteranceId !== '0')?.utteranceId ?? '';
/** Tutor turns that answer a student turn (the opening does not count). */
const replyTurns = (srv: ServerSession) => {
  const o = openingUtterance(srv);
  return srv.turns.filter(t => t.role === 'tutor' && t.utteranceId !== o);
};

async function readPage(page: Page): Promise<{ events: Ev[]; state: PageState }> {
  return page.evaluate(() => ({ events: window.__tutor.events, state: window.__tutor.state })) as unknown as Promise<{ events: Ev[]; state: PageState }>;
}

async function snapshotDom(page: Page): Promise<DomSnapshot> {
  return page.evaluate(() => {
    const q = (s: string) => [...document.querySelectorAll(s)];
    const phaseEl = document.querySelector('[data-testid="phase-indicator"]');
    return {
      phase: phaseEl?.getAttribute('data-phase') ?? null,
      phaseText: phaseEl?.textContent?.trim() ?? '',
      noise: document.querySelector('[data-testid="noise-indicator"]')?.getAttribute('data-noise') ?? null,
      // Team canvas: all math_canvas items share one persistent animated canvas.
      mathBoard: (() => {
        // Legacy math_canvas board items, or the beat-driven lesson canvas (one per session).
        const el = document.querySelector('[data-testid="lesson-canvas"]') ?? document.querySelector('[data-testid="animated-math-board"]');
        return el ? { canvas: !!el.querySelector('.teaching-canvas'), error: !!el.querySelector('[role="alert"]') } : null;
      })(),
      board: q('[data-testid="board-item"]').map(el => ({
        id: el.getAttribute('data-id') ?? '',
        kind: el.getAttribute('data-kind') ?? '',
        revealed: el.getAttribute('data-revealed') === 'true',
        known: el.getAttribute('data-known') === 'true',
        fallback: !!el.querySelector('[data-testid="board-fallback"]'),
        empty: (el.textContent ?? '').trim() === '' && !el.querySelector('svg,canvas,img,.katex'),
      })),
      tutorCaptions: q('[data-testid="caption-tutor"]').flatMap(c =>
        [...c.querySelectorAll('[data-testid="caption-sentence"]')].map(s => ({
          utteranceId: c.getAttribute('data-ref') ?? '',
          idx: s.getAttribute('data-id') ?? '',
          status: s.getAttribute('data-status') ?? '',
          text: (s.textContent ?? '').trim(),
        }))
      ),
      studentCaptions: q('[data-testid="caption-phrase"]').map(s => ({ phraseId: s.getAttribute('data-id') ?? '', text: (s.textContent ?? '').trim() })),
    };
  });
}

async function sampleObserver(page: Page): Promise<ObserverSample> {
  return page.evaluate(() => ({
    wall: Date.now(),
    phase: document.querySelector('[data-testid="phase-indicator"]')?.getAttribute('data-phase') ?? null,
    tutor: [...document.querySelectorAll('[data-testid="caption-tutor"]')].flatMap(c =>
      [...c.querySelectorAll('[data-testid="caption-sentence"]')].map(s => ({ utteranceId: c.getAttribute('data-ref') ?? '', idx: s.getAttribute('data-id') ?? '', text: (s.textContent ?? '').trim() }))
    ),
    student: [...document.querySelectorAll('[data-testid="caption-phrase"]')].map(s => (s.textContent ?? '').trim()).filter(Boolean),
  }));
}

export interface RunContext {
  db: string;
  baseUrl: string;
  runTag: string;
  attempt: number;
  /** Per-run output directory (raw page dumps). */
  outDir: string;
  log: (m: string) => void;
}

export async function runScenario(sc: Scenario, ctx: RunContext): Promise<ScenarioRun> {
  const fixture = loadFixture(sc.fixture);
  const started = Date.now();
  const learnerName = `E2E ${sc.id} ${ctx.runTag}${ctx.attempt > 1 ? ` r${ctx.attempt}` : ''}`;
  const run: ScenarioRun = {
    id: sc.id,
    fixture: sc.fixture,
    attempt: ctx.attempt,
    status: 'fail',
    sessionId: '',
    learnerName,
    durationMs: 0,
    checks: [],
    metrics: [],
    localLatencyMs: [],
    transcript: '',
    sourceText: fixture.text,
    externalEvidence: [],
  };
  const pageLog: string[] = [];
  const log = (m: string) => ctx.log(`[${sc.id}] ${m}`);
  const mic = await launch(path.join(FIXTURES, `${sc.fixture}.wav`), E2E_DEFAULTS.openingLeadMs);
  // The observer gets its own browser (no mic): a second tab in the mic browser is a background
  // tab whose evaluate calls can stall while the session tab is busy.
  const viewer = sc.observer ? await launch(null) : null;
  let observerSamples: ObserverSample[] = [];
  let stopObserver = () => {};
  let page: Page | undefined;
  try {
    page = await mic.newPage(sc.id, m => pageLog.push(m));
    const base = `${ctx.baseUrl}?db=${encodeURIComponent(ctx.db)}${E2E_DEFAULTS.clientQuery ? `&${E2E_DEFAULTS.clientQuery}` : ''}`;
    run.sessionId = await createSessionViaUi(page, base, learnerName, TASK_TEXT);
    log(`session ${run.sessionId} (learner "${learnerName}")`);
    run.checks.push({ name: 'ui.session', status: 'pass', detail: `session ${run.sessionId} via create-user → learner → start-session` });

    if (sc.observer) {
      const obs = await viewer!.newPage(`${sc.id}/observer`, m => pageLog.push(m));
      await obs.goto(`${base}&observe=${run.sessionId}`, { waitUntil: 'domcontentloaded' });
      await obs.waitForSelector(tid('observer-screen'), { timeout: 15_000 });
      let on = true;
      stopObserver = () => (on = false);
      void (async () => {
        while (on) {
          try {
            observerSamples.push(await sampleObserver(obs));
          } catch {
            /* page busy */
          }
          await sleep(250);
        }
      })();
    }

    const talkAt = await startTalking(page);
    log('talking');

    // Wait until every expected tutor reply is complete and played (or the timeout).
    const deadline = talkAt + E2E_DEFAULTS.openingLeadMs + sc.timeoutMs;
    let settledSince = 0;
    let done = false;
    while (Date.now() < deadline) {
      await sleep(1000);
      const { state } = await readPage(page);
      const srv = readSession(ctx.db, run.sessionId);
      const tutorTurns = replyTurns(srv).length;
      const pagePending = state.sentences.some(s => !DONE_SENTENCE.has(s.status));
      const ok = tutorTurns >= sc.turns && !pagePending && !state.tutorAudio && state.turnState !== 'speaking' && state.turnState !== 'thinking';
      if (ok) {
        settledSince ||= Date.now();
        // A little grace for board reveals / metrics written after playback.
        if (Date.now() - settledSince >= 1500) {
          done = true;
          break;
        }
      } else settledSince = 0;
    }
    stopObserver();
    const { events, state } = await readPage(page);
    const dom = await snapshotDom(page);
    const server = readSession(ctx.db, run.sessionId);
    run.page = state;
    run.server = server;
    run.metrics = server.metrics;
    run.localLatencyMs = state.localLatencyMs ?? [];
    fs.writeFileSync(
      path.join(ctx.outDir, `${sc.id}-a${ctx.attempt}.json`),
      JSON.stringify({ events, state, dom, server, observerSamples: observerSamples.slice(-20), pageLog }, null, 1)
    );
    run.checks.push({ name: 'completed', status: done ? 'pass' : 'fail', detail: done ? `in ${Math.round((Date.now() - talkAt) / 1000)} s` : `not settled after ${(E2E_DEFAULTS.openingLeadMs + sc.timeoutMs) / 1000} s (tutor replies ${replyTurns(server).length}/${sc.turns}, opening ${openingUtterance(server) ? 'yes' : 'no'})` });
    evaluate(run, sc, fixture, events, state, dom, server, observerSamples);
  } catch (e) {
    run.error = e instanceof Error ? (e.stack ?? e.message) : String(e);
    // What the page showed when the flow broke (e.g. "Session N does not exist", a render error).
    const shown = await page
      ?.evaluate(() => (document.querySelector('main')?.textContent ?? document.body.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 160))
      .catch(() => '');
    run.checks.push({ name: 'harness', status: 'fail', detail: `${run.error.split('\n')[0]!}${shown ? ` | page: ${shown}` : ''}` });
  } finally {
    stopObserver();
    await mic.close();
    await viewer?.close();
  }
  if (pageLog.length) fs.appendFileSync(path.join(ctx.outDir, `${sc.id}-a${ctx.attempt}.pagelog`), pageLog.join('\n') + '\n');
  run.durationMs = Date.now() - started;
  run.status = run.checks.some(c => c.status === 'fail') ? 'fail' : 'pass';
  return run;
}

// ---------------------------------------------------------------- assertions

function evaluate(run: ScenarioRun, sc: Scenario, fx: Fixture, events: Ev[], state: PageState, dom: DomSnapshot, srv: ServerSession, obs: ObserverSample[]): void {
  const add = (name: string, status: CheckStatus, detail: string) => run.checks.push({ name, status, detail });
  const ofType = (p: string) => events.filter(e => e.type === p || e.type.startsWith(p + '.'));
  const openingU = openingUtterance(srv);
  evaluateOpening(add, ofType, srv, openingU);

  // Transcript vs. fixture text.
  const studentPhrases = srv.phrases.filter(p => p.text.trim());
  run.transcript = studentPhrases.map(p => p.text.trim()).join(' ');
  const recall = wordRecall(fx.text, run.transcript);
  add('transcript', recall >= E2E_DEFAULTS.transcriptThreshold ? 'pass' : 'fail', `recall ${recall.toFixed(2)}: "${run.transcript}"`);

  // Student turns.
  const studentTurns = srv.turns.filter(t => t.role === 'student' && t.text.trim());
  const turnEnds = ofType('vad.turn_end');
  if (sc.singleTurn) {
    // The first play of a reply to the student (the opening plays before the student speaks).
    const firstPlay = ofType('audio.play_start').find(e => String(e.utteranceId) !== openingU)?.t ?? Infinity;
    const endsBefore = turnEnds.filter(e => e.t < firstPlay).length;
    const turnsOfPhrases = new Set(studentPhrases.map(p => p.turnIdx));
    add(
      'single-turn',
      studentTurns.length === 1 && turnsOfPhrases.size === 1 && endsBefore === 1 ? 'pass' : 'fail',
      `${studentPhrases.length} phrases in ${turnsOfPhrases.size} turn(s), ${studentTurns.length} student turn(s), ${endsBefore} turn_end before the reply; gaps ${JSON.stringify((fx as unknown as { gapsMs?: number[] }).gapsMs ?? [])} ms`
    );
  } else {
    add('student-turns', studentTurns.length === sc.turns ? 'pass' : 'warn', `${studentTurns.length} student turn(s), expected ${sc.turns}`);
  }

  // Turn ends: silence after the last speech when the turn ended, and why (Smart Turn verdict
  // or the VAD_TURN_MS fallback). Informational; warns only if Smart Turn never answered.
  const smart = ofType('vad.smart_turn');
  const smartReady = ofType('smart_turn.ready');
  const smartFailed = ofType('smart_turn.error');
  add(
    'turn-end',
    smartFailed.length || (smartReady.length && !smart.some(e => e.prob !== null)) ? 'warn' : 'pass',
    turnEnds.map(e => `${e.reason ?? '?'} after ${e.silenceMs ?? '?'} ms silence`).join('; ') +
      (smart.length ? ` | smart_turn: ${smart.map(e => `p=${e.prob ?? '–'} ${e.decision} ${e.ms} ms`).join(', ')}` : '') +
      (smartReady.length ? ` | model ready in ${smartReady[0]!.loadMs} ms` : '') +
      (smartFailed.length ? ` | errors: ${smartFailed.map(e => e.error).join(', ')}` : '')
  );

  // Tutor replies: sentences in order, audio received and played in idx order.
  const utterances = [...new Set(srv.sentences.map(s => s.utteranceId))];
  const replyIssues: string[] = [];
  const audioIssues: string[] = [];
  const received = ofType('audio.received');
  const plays = ofType('audio.play_start');
  for (const u of utterances) {
    const ss = srv.sentences.filter(s => s.utteranceId === u);
    const idxs = ss.map(s => s.idx).sort((a, b) => a - b);
    if (idxs.some((v, i) => v !== i)) replyIssues.push(`u${u}: idx ${idxs.join(',')} not contiguous`);
    const pending = ss.filter(s => !DONE_SENTENCE.has(s.status));
    if (pending.length) replyIssues.push(`u${u}: ${pending.length} sentence(s) not played/dropped (${pending.map(s => `${s.idx}:${s.status}`).join(' ')})`);
    const uPlays = plays.filter(e => e.utteranceId === u).map(e => Number(e.idx));
    if (uPlays.some((v, i) => i > 0 && v <= uPlays[i - 1]!)) audioIssues.push(`u${u}: play order ${uPlays.join(',')}`);
    for (const p of plays.filter(e => e.utteranceId === u)) {
      const r = received.find(x => x.utteranceId === u && x.idx === p.idx);
      if (!r || r.t > p.t) audioIssues.push(`u${u}#${p.idx}: played before received`);
    }
    for (const s of ss.filter(s => s.status === 'played')) {
      if (!uPlays.includes(s.idx)) audioIssues.push(`u${u}#${s.idx}: status played but no local play_start`);
    }
  }
  const played = srv.sentences.filter(s => s.status === 'played');
  const replies = utterances.filter(u => u !== openingU);
  add(
    'reply',
    replies.length >= sc.turns && played.some(s => s.utteranceId !== openingU) && !replyIssues.length ? 'pass' : 'fail',
    `${replies.length} reply utterance(s) + ${openingU ? 1 : 0} opening, ${srv.sentences.length} sentences (${played.length} played)${replyIssues.length ? '; ' + replyIssues.join('; ') : ''}`
  );
  add('audio-order', plays.length > 0 && !audioIssues.length ? 'pass' : 'fail', `${received.length} blocks received, ${plays.length} played${audioIssues.length ? '; ' + audioIssues.join('; ') : ''}`);

  // Phase indicator.
  const phase = pack.phases.find(p => p.id === dom.phase);
  add('phase', phase && dom.phaseText.includes(phase.label) && dom.phase === srv.phase ? 'pass' : 'fail', `data-phase=${dom.phase} "${dom.phaseText}" (server ${srv.phase})`);

  // Board.
  if (!srv.boardItems.length) add('board', 'skip', 'tutor showed no board item');
  else {
    const bad = dom.board.filter(b => b.revealed && (b.fallback || !b.known || b.empty));
    const hidden = dom.board.filter(b => !b.revealed);
    // math_canvas items render inside the shared animated canvas (no per-item element).
    const mathOk = !!dom.mathBoard && dom.mathBoard.canvas && !dom.mathBoard.error;
    const missing = srv.boardItems.filter(b => !dom.board.some(d => d.id === b.id) && !(b.kind === 'math_canvas' && mathOk)); // pack-literal-ok
    if (dom.mathBoard?.error) bad.push({ id: 'math', kind: 'math_canvas', revealed: true, known: true, fallback: true, empty: false }); // pack-literal-ok
    add(
      'board',
      !bad.length && !missing.length ? (hidden.length ? 'warn' : 'pass') : 'fail',
      `${dom.board.length} item(s) [${dom.board.map(b => b.kind).join(', ')}]` +
        (bad.length ? `; fallback/empty: ${bad.map(b => `${b.kind}#${b.id}`).join(', ')}` : '') +
        (hidden.length ? `; still hidden after reply: ${hidden.map(b => `${b.kind}#${b.id}`).join(', ')}` : '') +
        (missing.length ? `; not rendered: ${missing.map(b => b.id).join(', ')}` : '')
    );
  }

  // Inline board markers: an item with a marker appears while its sentence plays (at the
  // marker word), or at once if it arrived after that sentence had finished.
  const marked = state.boardItems.filter(b => (b.markerPos ?? -1) >= 0);
  if (!marked.length) add('board-markers', 'skip', `no board item with an inline marker (${state.boardItems.length} item(s))`);
  else {
    const TOL_MS = 150;
    const issues: string[] = [];
    const notes: string[] = [];
    const ends = ofType('audio.play_end');
    for (const b of marked) {
      const reveal = ofType('board.reveal').find(e => e.id === b.id);
      const seen = ofType('board.seen').find(e => e.id === b.id);
      const start = plays.find(e => e.utteranceId === b.utteranceId && Number(e.idx) === b.sentenceIdx);
      const end = ends.find(e => e.utteranceId === b.utteranceId && Number(e.idx) === b.sentenceIdx);
      if (!reveal) {
        issues.push(`#${b.id}: never revealed`);
        continue;
      }
      if (!start || !end) {
        notes.push(`#${b.id}: sentence ${b.sentenceIdx} not played here`);
        continue;
      }
      const late = seen && seen.t > end.t; // arrived after its sentence: shown at once
      const inMs = Math.round(reveal.t - start.t);
      const dur = Math.round(end.t - start.t);
      if (late) {
        if (reveal.t - seen!.t > TOL_MS) issues.push(`#${b.id}: arrived late but revealed ${Math.round(reveal.t - seen!.t)} ms later`);
        else notes.push(`#${b.id} late arrival, immediate`);
      } else if (reveal.t < start.t - TOL_MS || reveal.t > end.t + TOL_MS) {
        issues.push(`#${b.id}: revealed ${inMs} ms after its sentence started (sentence ${dur} ms)`);
      } else {
        // The tab's own marker-word time (TTS word timestamps or estimate), when it knew it.
        const at = typeof reveal.markerAt === 'number' ? reveal.markerAt : null;
        const wordMs = at === null ? null : Math.round(at - start.t);
        const arrivedAfterWord = at !== null && !!seen && seen.t > at;
        if (at !== null && !arrivedAfterWord && Math.abs(reveal.t - at) > TOL_MS) issues.push(`#${b.id}: revealed at ${inMs} ms, its word plays at ${wordMs} ms`);
        else notes.push(`#${b.id} at ${inMs}/${dur} ms (word ${wordMs ?? '?'} ms${arrivedAfterWord ? ', arrived after it' : ''}, pos ${b.markerPos})`);
      }
    }
    add('board-markers', issues.length ? 'fail' : 'pass', `${marked.length} marked item(s): ${[...issues, ...notes].join('; ')}`);
  }

  // turn_metrics.
  // Replies to student turns (the opening's row is checked in evaluateOpening).
  const replied = srv.metrics.filter(m => m.utteranceId !== '0' && m.turnIdx !== OPENING_TURN_IDX);
  const noAudio = replied.filter(m => m.firstAudio === null);
  const slow = replied.filter(m => m.firstAudio !== null && m.firstAudio > E2E_DEFAULTS.latencyTargetMs);
  add(
    'turn-metrics',
    replied.length >= sc.turns && !noAudio.length ? (slow.length ? 'warn' : 'pass') : 'fail',
    replied.map(m => `t${m.turnIdx}: stt ${m.sttDone ?? '–'} / llm ${m.llmFirstToken ?? '–'} / sent ${m.firstSentence ?? '–'} / audio ${m.firstAudio ?? '–'} / play ${m.firstPlayback ?? '–'} ms${m.preemptive ? ' (pre)' : ''}`).join('; ') +
      (slow.length ? ` — above ${E2E_DEFAULTS.latencyTargetMs} ms target` : '') +
      (replied.length < sc.turns ? ` — only ${replied.length} row(s) with a reply` : '')
  );
  // Rows for turns that never existed (e.g. noise reported after the turn already became ready).
  const studentIdx = new Set(srv.turns.filter(t => t.role === 'student').map(t => t.idx));
  const phantom = srv.metrics.filter(m => m.utteranceId === '0' && !studentIdx.has(m.turnIdx) && m.turnIdx !== OPENING_TURN_IDX);
  const noNoise = replied.filter(m => m.noiseDb === 0);
  add(
    'metrics-noise',
    phantom.length || noNoise.length ? 'warn' : 'pass',
    `noiseDb per replied turn: ${replied.map(m => `t${m.turnIdx} ${m.noiseDb.toFixed(0)}`).join(', ')}` +
      (phantom.length ? `; ${phantom.length} row(s) for non-existent turn(s) ${phantom.map(m => `t${m.turnIdx} (noiseDb ${m.noiseDb.toFixed(0)})`).join(', ')}` : '')
  );

  // No foreign data on this page (subscriptions are per session).
  const ownU = new Set(srv.sentences.map(s => s.utteranceId));
  const ownB = new Set(srv.boardItems.map(b => b.id));
  const ownP = new Set(srv.phrases.map(p => `${p.phraseId}:${p.text}`));
  const foreign = [
    ...state.sentences.filter(s => !ownU.has(s.utteranceId)).map(s => `sentence u${s.utteranceId}`),
    ...state.boardItems.filter(b => !ownB.has(b.id)).map(b => `board #${b.id}`),
    ...state.phrases.filter(p => p.status === 'done' && !ownP.has(`${p.phraseId}:${p.text}`)).map(p => `phrase ${p.phraseId}`),
    ...received.filter(e => !ownU.has(String(e.utteranceId))).map(e => `audio u${e.utteranceId}`),
  ];
  add('own-data-only', foreign.length ? 'fail' : 'pass', foreign.length ? foreign.slice(0, 5).join(', ') : `${state.phrases.length} phrases, ${state.sentences.length} sentences, ${state.boardItems.length} board items all from session ${srv.sessionId}`);

  if (sc.noisy) {
    const states = [...new Set(ofType('noise.state').map(e => String(e.state)))];
    const floor = ofType('noise.state').map(e => Number(e.floorDb)).filter(Number.isFinite);
    const notQuiet = states.some(s => s !== 'quiet') || (dom.noise !== null && dom.noise !== 'quiet');
    add('noise-indicator', notQuiet ? 'pass' : 'fail', `states seen [${states.join(', ')}], final ${dom.noise}, floor up to ${floor.length ? Math.max(...floor).toFixed(0) : '–'} dBFS`);
  }

  if (sc.interrupt) evaluateInterrupt(add, fx, ofType, srv, run);
  if (sc.observer) evaluateObserver(add, obs, dom, srv, ofType);
}

/** The tutor speaks first: one opening utterance before any student turn, fully played before the
 *  student starts, with a short first sentence and a question at the end. */
function evaluateOpening(add: (n: string, s: CheckStatus, d: string) => void, ofType: (p: string) => Ev[], srv: ServerSession, u: string): void {
  const m = srv.metrics.find(x => x.turnIdx === OPENING_TURN_IDX);
  if (!m || !u) {
    add('opening', 'fail', m ? 'startConversation recorded, but no opening utterance started (beginOpening)' : 'no opening requested (startConversation) on a fresh session');
    return;
  }
  const ss = srv.sentences.filter(s => s.utteranceId === u);
  const turn = srv.turns.find(t => t.role === 'tutor' && t.utteranceId === u);
  const firstStudent = srv.turns.find(t => t.role === 'student');
  const issues: string[] = [];
  if (!turn) issues.push('no tutor turn');
  else if (turn.idx !== 0) issues.push(`tutor turn is #${turn.idx}, not #0`);
  if (firstStudent && turn && firstStudent.idx < turn.idx) issues.push('a student turn comes first');
  if (!ss.some(s => s.status === 'played')) issues.push('nothing played');
  const warns: string[] = [];
  if (turn?.interrupted) warns.push('interrupted (student spoke during the opening: lead-in too short?)');
  // Played completely before the student started speaking.
  const lastEnd = ofType('audio.play_end').filter(e => String(e.utteranceId) === u).pop();
  const speech = ofType('vad.speech_start')[0];
  if (lastEnd && speech && speech.t < lastEnd.t) warns.push(`student speech started ${Math.round(lastEnd.t - speech.t)} ms before the opening ended`);
  const first = ss.find(s => s.idx === 0)?.display ?? '';
  const words = first.split(/\s+/).filter(Boolean).length;
  if (words > E2E_DEFAULTS.openingFirstSentenceMaxWords) warns.push(`first sentence has ${words} words`);
  const last = [...ss].sort((a, b) => a.idx - b.idx).pop()?.display ?? '';
  if (!/\?["'”’)]*\s*$/.test(last)) warns.push('does not end with a question');
  add(
    'opening',
    issues.length ? 'fail' : warns.length ? 'warn' : 'pass',
    `u${u}: ${ss.length} sentence(s), click → audio ${m.firstAudio ?? '–'} / play ${m.firstPlayback ?? '–'} ms; first "${first}" (${words} words); last "${last}"` +
      (issues.length ? `; ${issues.join('; ')}` : '') +
      (warns.length ? `; ${warns.join('; ')}` : '')
  );
}

function evaluateInterrupt(
  add: (n: string, s: CheckStatus, d: string) => void,
  fx: Fixture,
  ofType: (p: string) => Ev[],
  srv: ServerSession,
  run: ScenarioRun
): void {
  const barge = ofType('vad.barge_in')[0];
  const call = ofType('reducer.call').find(e => e.name === 'interrupt' || e.name === 'interruptUtterance');
  const flush = ofType('audio.flush').find(e => e.reason === 'barge_in');
  if (!barge) {
    const firstPlay = ofType('audio.play_start')[0];
    const secondSpeech = ofType('vad.speech_start')[1];
    add('barge-in', 'fail', `no vad.barge_in (first tutor audio at ${firstPlay ? Math.round(firstPlay.t) : '–'} ms, second speech start at ${secondSpeech ? Math.round(secondSpeech.t) : '–'} ms page time)`);
    return;
  }
  add('barge-in', call && flush ? 'pass' : 'fail', `vad.barge_in after ${barge.speechMs} ms speech; interrupt call ${call ? 'yes' : 'NO'}; audio.flush(barge_in) ${flush ? `stopped ${flush.stopped}` : 'NO'}`);
  if (flush) {
    const stopMs = flush.t - barge.t;
    // The interrupted utterance must not play anything after the flush.
    const u = String(flush.utteranceId && flush.utteranceId !== '0' ? flush.utteranceId : (ofType('audio.play_start').filter(e => e.t < barge.t).pop()?.utteranceId ?? ''));
    const lateStarts = ofType('audio.play_start').filter(e => e.utteranceId === u && e.t > flush.t);
    const lastEnd = ofType('audio.play_end').filter(e => e.utteranceId === u).pop();
    add(
      'barge-in-stop',
      stopMs <= E2E_DEFAULTS.bargeInStopMs && !lateStarts.length ? 'pass' : 'fail',
      `tutor audio flushed ${Math.round(stopMs)} ms after barge-in${lateStarts.length ? `; ${lateStarts.length} play_start(s) after flush` : ''}${lastEnd ? `; last play_end ${Math.round(lastEnd.t - barge.t)} ms rel.` : ''}`
    );
    const ss = srv.sentences.filter(s => s.utteranceId === u);
    const dropped = ss.filter(s => s.status === 'dropped');
    const tutorTurn = srv.turns.find(t => t.role === 'tutor' && t.utteranceId === u);
    add(
      'dropped-sentences',
      dropped.length > 0 ? 'pass' : 'warn',
      `u${u}: ${ss.length} sentences, ${dropped.length} dropped (${ss.map(s => `${s.idx}:${s.status}`).join(' ')})`
    );
    // The tutor turn records what was actually spoken (prompt context + memory extraction).
    const unheard = dropped.filter(s => tutorTurn?.text.includes(s.display.trim()));
    add(
      'interrupted-turn',
      tutorTurn && tutorTurn.interrupted && !unheard.length ? 'pass' : 'fail',
      tutorTurn
        ? `tutor turn #${tutorTurn.idx} interrupted=${tutorTurn.interrupted}${unheard.length ? `; text contains ${unheard.length} dropped (unheard) sentence(s): "${unheard[0]!.display}"` : ''}`
        : 'no tutor turn for the interrupted utterance'
    );
    // The tutor answers the interruption: a later utterance, played, after a later student turn.
    const later = [...new Set(srv.sentences.map(s => s.utteranceId))].filter(x => x !== u && BigInt(x) > BigInt(u || '0'));
    const answered = later.some(x => srv.sentences.some(s => s.utteranceId === x && s.status === 'played'));
    const second = fx.timeline[fx.timeline.length - 1]!.say;
    const laterStudent = srv.turns.filter(t => t.role === 'student' && t.text.trim() && t.idx > (tutorTurn?.idx ?? -1));
    const r2 = wordRecall(second, laterStudent.map(t => t.text).join(' '));
    add(
      'responds-to-interruption',
      answered && r2 >= E2E_DEFAULTS.transcriptThreshold ? 'pass' : 'fail',
      `${later.length} later utterance(s)${answered ? ' played' : ' NOT played'}; interruption transcript recall ${r2.toFixed(2)}: "${laterStudent.map(t => t.text).join(' ')}"`
    );
  }
  void run;
}

function evaluateObserver(
  add: (n: string, s: CheckStatus, d: string) => void,
  obs: ObserverSample[],
  dom: DomSnapshot,
  srv: ServerSession,
  ofType: (p: string) => Ev[]
): void {
  const last = obs[obs.length - 1];
  if (!last) return add('observer', 'fail', 'no observer samples');
  const issues: string[] = [];
  if (last.phase !== dom.phase) issues.push(`phase ${last.phase} vs ${dom.phase}`);
  const playedSession = dom.tutorCaptions.filter(c => c.status === 'played');
  for (const c of playedSession) {
    const o = last.tutor.find(x => x.utteranceId === c.utteranceId && x.idx === c.idx);
    if (!o || o.text !== c.text) issues.push(`sentence u${c.utteranceId}#${c.idx} ${o ? 'text differs' : 'missing'}`);
  }
  const studentSession = dom.studentCaptions.map(s => s.text).filter(Boolean);
  if (studentSession.join(' ') !== last.student.join(' ')) issues.push(`student captions differ: "${last.student.join(' ')}"`);
  // Live: the observer shows the first tutor sentence soon after the session tab starts playing it.
  const firstPlay = ofType('audio.play_start')[0];
  let lagMs: number | null = null;
  if (firstPlay) {
    const seen = obs.find(s => s.tutor.some(x => x.utteranceId === firstPlay.utteranceId && x.idx === String(firstPlay.idx) && x.text));
    lagMs = seen ? seen.wall - firstPlay.wall : null;
    if (lagMs === null) issues.push('first sentence never appeared live');
  }
  const phases = [...new Set(obs.map(s => s.phase))];
  add(
    'observer',
    issues.length ? 'fail' : lagMs !== null && lagMs > 2000 ? 'warn' : 'pass',
    `${obs.length} samples, phases seen [${phases.join(' → ')}], first sentence shown ${lagMs ?? '–'} ms after session playback` + (issues.length ? `; ${issues.join('; ')}` : '') + `; server board ${srv.boardItems.length}`
  );
}

/** Lines from the module / worker logs that point at an external API failure for this run. */
export function externalEvidence(run: ScenarioRun, moduleLog: string[], workerLog: string[]): string[] {
  if (!run.sessionId) return [];
  const sid = run.sessionId;
  const utts = new Set((run.server?.sentences ?? []).map(s => s.utteranceId));
  const net = /fetch failed|ECONN|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up|timed? ?out|network|TLS|certificate|\b(408|429|5\d\d)\b|connection (reset|refused|closed)|overloaded|rate limit/i;
  const out: string[] = [];
  for (const l of moduleLog) {
    if (!/WARN|ERROR/.test(l)) continue;
    const s = l.match(/session (\d+)\b/)?.[1];
    const u = l.match(/utterance (\d+)\b/)?.[1];
    if ((s === sid || (u && utts.has(u))) && net.test(l)) out.push(`module: ${l.trim()}`);
  }
  for (const l of workerLog) {
    if (!l.includes(`[s${sid} `) && !l.includes(`[s${sid}]`)) continue;
    if (/reply failed|llm|openrouter|stream/i.test(l) && net.test(l)) out.push(`worker: ${l.trim()}`);
    else if (/reply failed/.test(l)) out.push(`worker: ${l.trim()}`);
  }
  return out;
}
