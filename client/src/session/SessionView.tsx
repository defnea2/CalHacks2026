// One session screen for voice and text (the team's lesson layout): the canvas is the main
// area, a small conversation column on the side. The learner can talk (VAD → pushAudio) or type
// (submitTextTurn); the lesson buttons are turns with an intent; canvas manipulations go to
// submitInteraction. Everything lesson-related is read from SpacetimeDB rows (beat,
// lesson_state, canvas_state); this component only keeps presentation state (local audio,
// text-mode pause/next/replay).
//
// <SessionView readOnly /> is the observer (?observe=<id>), reused by the classroom dashboard:
// no microphone, no audio, no inputs; reveals follow reply_sentence status `played`.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useReducedMotion } from 'motion/react';
import type { DbConnection } from '../module_bindings';
import type { ReplySentence } from '../module_bindings/types';
import type { AppSettings } from '../config';
import { useSessionData } from '../stdb/useSessionData';
import { callReducer } from '../stdb/connection';
import { VoiceSession, type VoiceUiState } from '../audio/VoiceSession';
import { Board, type BoardItemView } from '../board/Board';
import { markerOffsetMs, type SentenceTiming } from '../board/reveal';
import { Captions, DebugPanel, INTENT_LABELS, Indicators, SessionTitle, useUtteranceState } from '../components/session';
import { Button, ErrorNote } from '../components/ui';
import { APP_CONFIG } from '../app-config';
import { compressPhoto } from '../lib/photo';
import { eventLog } from '../lib/debug';
import { homeUrl, navigate, sessionUrl } from '../lib/format';
import { shouldStartConversation } from '../lib/conversation';
import { latestUtteranceBeats, orderBeats, parseScene, revealCount } from '../lesson/beatPlayer';
import { parseNotes } from '@tutor/visual/teaching/spacetimeModel';
import { LessonCanvas } from './LessonCanvas';
import { useTextPlayback } from './useTextPlayback';
import { useAgentStatus } from './useAgentStatus';
import '../studio.css';

const PLAYED = 'played';
const SPEAKING = 'speaking';
const DROPPED = 'dropped';
const EMPTY_STARTED = new Map<string, number[]>();

/** Lesson stage labels (the team's phaseLabels). */
const STAGE_LABELS: Record<string, string> = {
  diagnose: 'What do you think?', intuition: 'Use the picture', formalize: 'Write it in math',
  worked_example: 'An example', repair: 'Try this', solo: 'Your turn',
  transfer: 'A new example', return_to_problem: 'Your original question',
};
const LESSON_INTENTS = ['another_way', 'smaller_step', 'continue', 'demonstrate'] as const;

interface CheckView {
  kind: string;
  prompt: string;
  options: { id: string; label: string }[];
}

function checkOf(notes: ReturnType<typeof parseNotes>, prompt: string): CheckView | null {
  const step = notes.step as { check?: { kind?: string; prompt?: string; options?: { id: string; label: string }[] } | null } | undefined;
  const c = step?.check;
  if (c && typeof c.prompt === 'string') return { kind: c.kind ?? 'explanation', prompt: c.prompt, options: Array.isArray(c.options) ? c.options : [] };
  return prompt ? { kind: 'explanation', prompt, options: [] } : null;
}

export interface SessionViewProps {
  conn: DbConnection;
  sessionId: bigint;
  /** Needed for the microphone; omitted in read-only views. */
  settings?: AppSettings;
  readOnly?: boolean;
}

export function SessionView({ conn, sessionId, settings, readOnly = false }: SessionViewProps) {
  const data = useSessionData(conn, sessionId, { withAudio: !readOnly });
  const { session } = data;
  const agent = useAgentStatus(conn);
  const reducedMotion = useReducedMotion() ?? false;
  const [voice, setVoice] = useState<VoiceSession | null>(null);
  const voiceRef = useRef<VoiceSession | null>(null);
  const [ui, setUi] = useState<VoiceUiState>({ listening: false, speaking: false, tutorAudio: false, noise: 'quiet', floorDb: null, levelDb: -100, prob: 0 });
  const [error, setError] = useState('');
  const [starting, setStarting] = useState(false);
  const [draft, setDraft] = useState('');
  const [localStarted, setLocalStarted] = useState<Map<string, number[]>>(() => new Map());
  /** Playback timing of the sentences this tab started ("utteranceId:idx"), for marker reveals. */
  const timings = useRef(new Map<string, SentenceTiming>());
  const [localLatency, setLocalLatency] = useState<Map<number, number>>(() => new Map());
  const lastTurnEnd = useRef<number | null>(null);
  const turnCounter = useRef(0);
  const [flushes, setFlushes] = useState(0);
  const debugOpen = readOnly || new URLSearchParams(window.location.search).get('debug') === '1';
  const [conversationOpen, setConversationOpen] = useState(true);
  const listening = !!voice?.capturing && ui.listening;

  const { progress, serverOver } = useUtteranceState(data, readOnly ? EMPTY_STARTED : localStarted);
  const mode: 'voice' | 'text' = session?.voice === false ? 'text' : 'voice';

  // ------------------------------------------------------------ lesson rows → canvas
  const beats = useMemo(() => orderBeats(data.beats), [data.beats]);
  const latest = useMemo(() => latestUtteranceBeats(beats), [beats]);
  const text = useTextPlayback(latest, mode === 'text' && !readOnly, reducedMotion);
  const started = useMemo(() => {
    const m = new Map<string, number[]>();
    for (const s of data.sentences) if (s.status === PLAYED) m.set(s.utteranceId.toString(), [...(m.get(s.utteranceId.toString()) ?? []), s.idx]);
    if (!readOnly) for (const [u, idx] of localStarted) m.set(u, [...new Set([...(m.get(u) ?? []), ...idx])]);
    return m;
  }, [data.sentences, localStarted, readOnly]);
  const shownCount = revealCount({ beats, started, over: serverOver, mode: readOnly && mode === 'text' ? 'voice' : mode, textShown: text.shown });
  // Observer of a text session: the module marks sentences played after their reading time.
  const count = readOnly && mode === 'text' ? Math.max(shownCount, revealCount({ beats, started, over: () => true, mode: 'voice', textShown: 0 })) : shownCount;
  const fallback = useMemo(() => parseScene(data.canvasState?.scene), [data.canvasState?.scene]);
  const current = beats[count - 1];
  const notes = useMemo(() => parseNotes(data.lessonState), [data.lessonState]);
  const stage = data.lessonState?.stage || '';
  const awaiting = !!data.lessonState?.awaitingResponse && session?.turnState !== 'thinking';
  const check = awaiting ? checkOf(notes, data.lessonState?.checkPrompt ?? '') : null;
  const thinking = session?.turnState === 'thinking';
  const active = !!session?.active;

  // Debug surface for the E2E harness.
  useEffect(() => {
    const st = window.__tutor.state;
    if (readOnly) st.observing = sessionId.toString();
    else st.sessionId = sessionId.toString();
    st.sessionReady = data.ready;
    st.phase = session?.phase ?? '';
    st.turnState = session?.turnState ?? '';
    st.category = session?.category ?? '';
    st.concept = session?.concept ?? '';
    st.lesson = { mode, stage, awaiting, beats: beats.length, shown: count, agentOnline: agent.online };
    st.boardItems = data.boardItems.map(b => ({ id: b.id.toString(), idx: b.idx, kind: b.kind, visible: b.visible, utteranceId: b.utteranceId.toString(), sentenceIdx: b.sentenceIdx, markerPos: b.markerPos, answerState: b.answerState }));
    if (readOnly) {
      st.flushes = flushes;
      return;
    }
    st.listening = ui.listening;
    st.noise = ui.noise;
    st.noiseFloorDb = ui.floorDb;
    st.tutorAudio = ui.tutorAudio;
    st.phrases = data.phrases.map(p => ({ phraseId: p.phraseId, turnIdx: p.turnIdx, status: p.status, text: p.text }));
    st.sentences = data.sentences.map(s => ({ utteranceId: s.utteranceId.toString(), idx: s.idx, status: s.status, display: s.display }));
    st.localLatencyMs = [...localLatency.values()];
  }, [readOnly, sessionId, data, session, ui, localLatency, flushes, mode, stage, awaiting, beats.length, count, agent.online]);

  // Observer: count playback flushes (E2E barge-in checks).
  useEffect(() => {
    if (!readOnly) return;
    const on = (_c: unknown, row: { sessionId: bigint; utteranceId: bigint }) => {
      if (row.sessionId !== sessionId) return;
      eventLog.log('observer.flush', { utteranceId: row.utteranceId.toString() });
      setFlushes(n => n + 1);
    };
    conn.db.playbackFlush.onInsert(on);
    return () => conn.db.playbackFlush.removeOnInsert(on);
  }, [readOnly, conn, sessionId]);

  // ------------------------------------------------------------ audio (session tab only)
  useEffect(() => {
    voice?.setServerSpeaking(session?.turnState === SPEAKING, session?.currentUtteranceId ?? 0n);
  }, [voice, session?.turnState, session?.currentUtteranceId]);

  useEffect(() => {
    if (!voice) return;
    for (const s of data.sentences) if (s.status === DROPPED) voice.playback.skip(s.utteranceId, s.idx);
  }, [voice, data.sentences]);

  const maxPhraseId = data.phrases.reduce((m, p) => Math.max(m, p.phraseId), 0);
  useEffect(() => {
    voice?.setNextPhraseId(maxPhraseId + 1);
  }, [voice, maxPhraseId]);

  useEffect(
    () => () => {
      void voiceRef.current?.stop();
      voiceRef.current = null;
    },
    []
  );

  const onSentenceStart = useCallback((u: bigint, idx: number, timing: SentenceTiming) => {
    timings.current.set(`${u}:${idx}`, timing);
    setLocalStarted(prev => {
      const k = u.toString();
      if (prev.get(k)?.includes(idx)) return prev;
      const next = new Map(prev);
      next.set(k, [...(prev.get(k) ?? []), idx]);
      return next;
    });
    if (idx === 0 && lastTurnEnd.current !== null) {
      const ms = Date.now() - lastTurnEnd.current;
      const n = turnCounter.current;
      lastTurnEnd.current = null;
      eventLog.log('latency.turn_end_to_first_audio', { ms, utteranceId: u.toString() });
      setLocalLatency(prev => new Map(prev).set(n, ms));
    }
  }, []);

  /** Tutor audio needs an AudioContext from a user gesture: created on the first click/send. */
  const ensureAudio = useCallback((): VoiceSession | null => {
    if (readOnly || !settings || mode === 'text') return voiceRef.current;
    if (voiceRef.current) return voiceRef.current;
    const v = new VoiceSession({
      conn,
      sessionId,
      settings,
      firstPhraseId: maxPhraseId + 1,
      onUi: s => setUi(prev => ({ ...prev, ...s })),
      onSentenceStart,
      onTurnEnd: wall => {
        lastTurnEnd.current = wall;
        turnCounter.current += 1;
      },
    });
    voiceRef.current = v;
    window.__tutor.voice = v;
    setVoice(v);
    return v;
  }, [readOnly, settings, mode, conn, sessionId, maxPhraseId, onSentenceStart]);

  const startTalking = async () => {
    setError('');
    setStarting(true);
    try {
      const v = ensureAudio() ?? null;
      if (!v) throw new Error('audio is off in this session');
      eventLog.log('ui.start_talking', {});
      await v.start();
      setVoice(v);
      // Fresh session: the tutor speaks first (audio can play now that the click created the AudioContext).
      if (shouldStartConversation(session)) {
        lastTurnEnd.current = Date.now();
        turnCounter.current += 1;
        const r = await callReducer('startConversation', { sessionId }, () => conn.reducers.startConversation({ sessionId }));
        if (!r.ok) eventLog.log('ui.start_conversation_failed', { error: r.error ?? '' });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      eventLog.log('ui.start_failed', { error: msg });
      setError(`Could not start the microphone: ${msg}`);
      await voiceRef.current?.stopCapture();
    } finally {
      setStarting(false);
    }
  };

  const stopTalking = async () => {
    await voiceRef.current?.stopCapture();
    setVoice(voiceRef.current);
  };

  const endSession = async () => {
    window.__tutor.voice = undefined;
    await voiceRef.current?.stop();
    voiceRef.current = null;
    setVoice(null);
    const r = await callReducer('endSession', { sessionId }, () => conn.reducers.endSession({ sessionId }));
    if (!r.ok) setError(r.error ?? 'failed');
  };

  // ------------------------------------------------------------ learner input (text + buttons)
  const sendTurn = async (textValue: string, intent: string) => {
    setError('');
    ensureAudio();
    const args = { sessionId, text: textValue, intent };
    eventLog.log('ui.text_turn', { intent, chars: textValue.length });
    lastTurnEnd.current = Date.now();
    turnCounter.current += 1;
    const r = await callReducer('submitTextTurn', args, () => conn.reducers.submitTextTurn(args));
    if (!r.ok) setError(r.error ?? 'Could not send.');
    return r.ok;
  };
  const sendInteraction = (kind: string, payload: unknown) => {
    const args = { sessionId, kind, payload: JSON.stringify(payload) };
    void callReducer('submitInteraction', args, () => conn.reducers.submitInteraction(args)).then(r => {
      if (!r.ok) eventLog.log('ui.interaction_rejected', { kind, error: r.error ?? '' });
    });
  };
  const cancelReply = () => {
    voiceRef.current?.playback.flush(undefined, 'barge_in');
    void callReducer('interrupt', { sessionId }, () => conn.reducers.interrupt({ sessionId }));
  };

  const submitAnswer = async (boardItemId: bigint, answer: string) => {
    const r = await callReducer('submitGapAnswer', { boardItemId, answer }, () => conn.reducers.submitGapAnswer({ boardItemId, answer }));
    if (!r.ok) setError(r.error ?? 'failed');
  };

  // Inline board markers (legacy board items): the item appears when its marker word plays.
  const speechOf = useMemo(() => new Map(data.sentences.map(s => [`${s.utteranceId}:${s.idx}`, s.speech])), [data.sentences]);
  const markerAt = useCallback(
    (item: BoardItemView) => {
      const k = `${item.utteranceId}:${item.sentenceIdx}`;
      const t = timings.current.get(k);
      const speech = speechOf.get(k);
      return t && speech !== undefined ? t.startMs + markerOffsetMs(speech, item.markerPos, t) : undefined;
    },
    [speechOf]
  );

  const shownBeatSentences = useMemo(() => new Set(beats.slice(0, count).map(b => `${b.utteranceId}:${b.sentenceIdx}`)), [beats, count]);
  const beatSentences = useMemo(() => new Set(beats.map(b => `${b.utteranceId}:${b.sentenceIdx}`)), [beats]);
  const tutorShown = useCallback(
    (s: ReplySentence) => {
      const k = `${s.utteranceId}:${s.idx}`;
      if (s.status === PLAYED || (!readOnly && (localStarted.get(s.utteranceId.toString()) ?? []).includes(s.idx))) return true;
      if (mode !== 'text' || s.status === DROPPED) return false;
      return beatSentences.has(k) ? shownBeatSentences.has(k) : s.status !== 'pending';
    },
    [readOnly, localStarted, mode, beatSentences, shownBeatSentences]
  );

  if (data.error) return <ErrorNote>Subscription failed: {data.error}</ErrorNote>;
  if (data.ready && !session) {
    return (
      <div data-testid="session-missing" className="py-16 text-center text-sm text-muted-foreground">
        Session {sessionId.toString()} does not exist.
      </div>
    );
  }

  const canvasInteractive = !readOnly && active && session?.turnState === 'listening' && !ui.tutorAudio;
  const stateLabel = !active ? 'Finished' : ui.tutorAudio ? 'Speaking' : thinking ? 'Thinking' : session?.turnState === SPEAKING ? 'Speaking' : listening ? 'Listening' : readOnly ? 'Observing' : mode === 'text' ? 'Your turn' : 'Microphone off';
  const narration = current?.narration ?? '';
  const spoken = check && narration.endsWith(check.prompt) ? narration.slice(0, -check.prompt.length).trim() : narration;
  const hasBoard = data.boardItems.some(b => b.visible);
  const presenting = mode === 'text' && !readOnly && latest.length > 0 && text.shown > 0;

  return (
    <div
      data-testid={readOnly ? 'observer-screen' : 'session-screen'}
      data-session-id={sessionId.toString()}
      data-mode={mode}
      className={`lesson-studio ${conversationOpen ? '' : 'conversation-hidden'} ${readOnly ? 'lesson-readonly' : ''}`}
    >
      <div className="lesson-topline">
        <div className="lesson-question">
          {readOnly && <span className="studio-eyebrow">Observer · read-only</span>}
          <h1 data-testid="task-display">{session?.taskText || 'What would you like to understand?'}</h1>
        </div>
        <button className="conversation-toggle" aria-expanded={conversationOpen} aria-controls={`lesson-conversation-${sessionId}`} onClick={() => setConversationOpen(v => !v)}>
          {conversationOpen ? 'Hide conversation' : 'Show conversation'}
        </button>
      </div>
      <ErrorNote>{error}</ErrorNote>
      <div className="lesson-layout">
        <section className="lesson-stage" aria-label="Learning canvas">
          {narration && <h2 data-testid="lesson-narration" className="stage-narration">{spoken || check?.prompt || narration}</h2>}
          <div className="lesson-picture">
            {beats.length ? (
              <LessonCanvas beats={beats} count={count} run={text.run} fallback={fallback} interactive={canvasInteractive} onInteraction={sendInteraction} />
            ) : hasBoard ? (
              <Board items={data.boardItems} progress={progress} serverOver={serverOver} onSubmitAnswer={readOnly ? undefined : submitAnswer} markerAt={readOnly ? undefined : markerAt} allowCanvasInteraction={canvasInteractive} />
            ) : (
              <div data-testid="board" className="canvas-welcome">
                <span className="welcome-mark" aria-hidden="true">↗</span>
                <h2>{thinking ? 'Building your picture…' : 'Your picture will appear here'}</h2>
                <p>{readOnly ? 'Waiting for the tutor.' : 'Talk or type: the tutor explains with a moving picture.'}</p>
              </div>
            )}
          </div>
          {presenting && latest.length > 1 && (
            <div className="lesson-playback" data-testid="lesson-playback" aria-label="Explanation playback">
              <div className="lesson-filmstrip" aria-label={`Part ${text.shown} of ${latest.length}`}>
                {latest.map((b, i) => <span key={b.key} className={i < text.shown ? 'seen' : ''} aria-current={i === text.shown - 1 ? 'step' : undefined} />)}
              </div>
              <span>{text.shown} / {latest.length}{thinking && <span className="lesson-more" role="status" aria-label="More coming"> …</span>}</span>
              <button type="button" data-testid="playback-pause" onClick={() => text.setPaused(p => !p)}>{text.paused ? 'Play' : 'Pause'}</button>
              <button type="button" data-testid="playback-next" disabled={text.shown >= latest.length} onClick={text.next}>Next</button>
              <button type="button" data-testid="playback-skip" disabled={text.shown >= latest.length} onClick={text.skip}>Skip to question</button>
              <button type="button" data-testid="playback-replay" title="Replay from the beginning and reset changes to this picture" onClick={text.replay}>Replay</button>
            </div>
          )}
          {!readOnly && (
            <footer className="stage-controls">
              <div className="voice-control">
                {!active ? (
                  <Button size="lg" onClick={() => navigate(homeUrl())}>Start another question</Button>
                ) : mode === 'text' ? null : !listening ? (
                  <Button size="lg" data-testid="start-talking" onClick={startTalking} disabled={starting || !active}>
                    <MicIcon />
                    {starting ? 'Starting…' : APP_CONFIG.startButtonText}
                  </Button>
                ) : (
                  <Button size="lg" variant="outline" data-testid="stop-talking" onClick={stopTalking}>
                    <MicIcon />
                    Pause microphone
                  </Button>
                )}
                {listening && <MicMeter ui={ui} />}
              </div>
              {active && (
                <form
                  className="stage-compose"
                  data-testid="text-form"
                  onSubmit={async e => {
                    e.preventDefault();
                    const t = draft.trim();
                    if (!t) return;
                    if (await sendTurn(t, '')) setDraft('');
                  }}
                >
                  <input data-testid="text-input" aria-label={check ? 'Your answer' : 'Type to the tutor'} autoComplete="off" maxLength={2000} value={draft} onChange={e => setDraft(e.target.value)} placeholder={check ? 'Your answer…' : 'Or type here…'} />
                  <button type="submit" data-testid="text-send" disabled={!draft.trim()} aria-label="Send">→</button>
                </form>
              )}
              <span className="stage-status" role="status" data-testid="stage-status">
                <i data-active={listening || thinking} />
                {stateLabel}
              </span>
              {ui.noise === 'noisy' && listening && <p role="status">{APP_CONFIG.noisyHint}</p>}
            </footer>
          )}
        </section>
        <aside id={`lesson-conversation-${sessionId}`} className="lesson-conversation" hidden={!conversationOpen} aria-label="Conversation">
          <div className="conversation-heading">
            <h2 data-testid="lesson-stage" data-stage={stage}>{STAGE_LABELS[stage] ?? 'Conversation'}</h2>
            <span>{data.learner?.name || 'You'} + tutor</span>
          </div>
          <Captions data={data} tutorShown={tutorShown} />
          {thinking && (
            <div className="lesson-planning" role="status" data-testid="lesson-thinking">
              <span className="lesson-more">{latest.length && !serverOver(latest[0]!.utteranceId) ? 'The rest of your lesson is arriving…' : 'Building your visual lesson…'}</span>
              {!readOnly && <button type="button" onClick={cancelReply}>Cancel</button>}
            </div>
          )}
          {!readOnly && active && check && (
            <div className="lesson-response" data-testid="lesson-check" data-kind={check.kind}>
              <p className="lesson-question" data-testid="check-prompt">{check.prompt}</p>
              {check.kind === 'choice' && check.options.length ? (
                <div className="lesson-choices">
                  {check.options.map((o, i) => (
                    <button key={o.id} type="button" data-testid="choice-option" data-option-id={o.id} onClick={() => void sendTurn(o.label, '')}>
                      <span aria-hidden="true">{String.fromCharCode(65 + i)}</span>
                      {o.label}
                      <span aria-hidden="true">↗</span>
                    </button>
                  ))}
                </div>
              ) : ['math_value', 'placement', 'order'].includes(check.kind) ? (
                <button
                  className="lesson-primary"
                  type="button"
                  data-testid="check-picture"
                  onClick={() => {
                    sendInteraction('check_picture', { canvas: fallback });
                    void sendTurn('Check my picture.', '');
                  }}
                >
                  Check my picture →
                </button>
              ) : (
                <p className="lesson-response-hint">Say it or type it below.</p>
              )}
            </div>
          )}
          {!readOnly && active && (
            <div className="lesson-help" data-testid="lesson-help">
              <span>{check ? 'Need a different approach?' : 'You can stop me anytime'}</span>
              <div>
                {LESSON_INTENTS.map(intent => (
                  <button key={intent} type="button" data-testid={`intent-${intent}`} onClick={() => void sendTurn('', intent)}>
                    {INTENT_LABELS[intent]}
                  </button>
                ))}
              </div>
            </div>
          )}
          <details className="lesson-details">
            <summary>Lesson details</summary>
            <div className="lesson-details-content">
              <SessionTitle data={data} suffix={readOnly ? 'Observer · read-only' : undefined} />
              <p data-testid="agent-status" data-online={agent.online}>{agent.label}</p>
              {!readOnly && <PhotoUpload conn={conn} sessionId={sessionId} hasImage={!!session?.hasImage} />}
              {!readOnly && <a data-testid="open-observer" href={sessionUrl('observe', sessionId)} target="_blank" rel="noreferrer">Open observer</a>}
              {!readOnly && <Button variant="ghost" size="sm" data-testid="end-session" onClick={endSession} disabled={!active}>Finish session</Button>}
            </div>
          </details>
        </aside>
      </div>
      {debugOpen && (
        <div className="lesson-debug">
          <Indicators data={data} noise={readOnly ? undefined : { state: ui.noise, floorDb: ui.floorDb }} />
          <DebugPanel data={data} localLatency={readOnly ? undefined : localLatency} />
        </div>
      )}
    </div>
  );
}

function MicIcon() {
  return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><rect x="9" y="2" width="6" height="12" rx="3" /><path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3M8 22h8" /></svg>;
}

function MicMeter({ ui }: { ui: VoiceUiState }) {
  const pct = Math.max(0, Math.min(100, ((ui.levelDb + 70) / 60) * 100));
  return <div className="studio-mic" data-testid="mic-state" data-listening={ui.listening} data-speaking={ui.speaking} data-tutor-audio={ui.tutorAudio} aria-label={ui.speaking ? 'You are speaking' : 'Microphone on'}>
    <span style={{ width: `${pct}%` }} />
  </div>;
}

function PhotoUpload({ conn, sessionId, hasImage }: { conn: DbConnection; sessionId: bigint; hasImage: boolean }) {
  const [state, setState] = useState<'idle' | 'busy' | 'done' | 'error'>('idle');
  const [msg, setMsg] = useState('');
  if (hasImage) return <p data-testid="photo-state" data-state="uploaded" className="text-xs text-muted-foreground">Photo attached.</p>;
  return (
    <label className="flex flex-col gap-1 text-xs text-muted-foreground">
      Add a photo of the task (optional)
      <input
        data-testid="session-photo-input"
        type="file"
        accept="image/*"
        disabled={state === 'busy'}
        onChange={async e => {
          const f = e.target.files?.[0];
          if (!f) return;
          setState('busy');
          try {
            const c = await compressPhoto(f, APP_CONFIG.photoMaxBytes, APP_CONFIG.photoMaxSide);
            const args = { sessionId, mime: c.mime, data: c.data };
            const r = await callReducer('uploadPhoto', args, () => conn.reducers.uploadPhoto(args));
            setState(r.ok ? 'done' : 'error');
            setMsg(r.ok ? `Uploaded (${Math.round(c.data.length / 1024)} KB)` : (r.error ?? 'failed'));
          } catch (err) {
            setState('error');
            setMsg(String(err));
          }
        }}
        className="text-sm"
      />
      {msg ? <span data-testid="photo-state" data-state={state}>{msg}</span> : null}
    </label>
  );
}
