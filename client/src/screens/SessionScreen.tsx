// Screen 2: the live session (?session=<id>; a reload resumes it).
import { useCallback, useEffect, useRef, useState } from 'react';
import type { DbConnection } from '../module_bindings';
import type { ReplySentence } from '../module_bindings/types';
import type { AppSettings } from '../config';
import { useSessionData } from '../stdb/useSessionData';
import { callReducer } from '../stdb/connection';
import { VoiceSession, type VoiceUiState } from '../audio/VoiceSession';
import { Board } from '../board/Board';
import { Captions, DebugPanel, Indicators, SessionTitle, useUtteranceState } from '../components/session';
import { Button, ErrorNote } from '../components/ui';
import { APP_CONFIG } from '../app-config';
import { compressPhoto } from '../lib/photo';
import { eventLog } from '../lib/debug';
import { homeUrl, navigate, sessionUrl } from '../lib/format';
import '../studio.css';

const PLAYED = 'played';
const SPEAKING = 'speaking';
const DROPPED = 'dropped';

export function SessionScreen({ conn, sessionId, settings }: { conn: DbConnection; sessionId: bigint; settings: AppSettings }) {
  const data = useSessionData(conn, sessionId, { withAudio: true });
  const { session } = data;
  const [voice, setVoice] = useState<VoiceSession | null>(null);
  const voiceRef = useRef<VoiceSession | null>(null);
  const [ui, setUi] = useState<VoiceUiState>({ listening: false, speaking: false, tutorAudio: false, noise: 'quiet', floorDb: null, levelDb: -100, prob: 0 });
  const [error, setError] = useState('');
  const [starting, setStarting] = useState(false);
  const [localStarted, setLocalStarted] = useState<Map<string, number[]>>(() => new Map());
  const [localLatency, setLocalLatency] = useState<Map<number, number>>(() => new Map());
  const lastTurnEnd = useRef<number | null>(null);
  const turnCounter = useRef(0);
  const debugOpen = new URLSearchParams(window.location.search).get('debug') === '1';
  const [conversationOpen, setConversationOpen] = useState(true);

  const { progress, serverOver } = useUtteranceState(data, localStarted);

  // Debug surface for the E2E harness.
  useEffect(() => {
    const st = window.__tutor.state;
    st.sessionId = sessionId.toString();
    st.sessionReady = data.ready;
    st.phase = session?.phase ?? '';
    st.turnState = session?.turnState ?? '';
    st.category = session?.category ?? '';
    st.concept = session?.concept ?? '';
    st.listening = ui.listening;
    st.noise = ui.noise;
    st.noiseFloorDb = ui.floorDb;
    st.tutorAudio = ui.tutorAudio;
    st.phrases = data.phrases.map(p => ({ phraseId: p.phraseId, turnIdx: p.turnIdx, status: p.status, text: p.text }));
    st.sentences = data.sentences.map(s => ({ utteranceId: s.utteranceId.toString(), idx: s.idx, status: s.status, display: s.display }));
    st.boardItems = data.boardItems.map(b => ({ id: b.id.toString(), idx: b.idx, kind: b.kind, visible: b.visible, utteranceId: b.utteranceId.toString(), sentenceIdx: b.sentenceIdx, answerState: b.answerState }));
    st.localLatencyMs = [...localLatency.values()];
  }, [sessionId, data, session, ui, localLatency]);

  // Server turn state raises the VAD threshold while the tutor speaks.
  useEffect(() => {
    voice?.setServerSpeaking(session?.turnState === SPEAKING, session?.currentUtteranceId ?? 0n);
  }, [voice, session?.turnState, session?.currentUtteranceId]);

  // Dropped sentences never get audio: don't let the queue wait for them.
  useEffect(() => {
    if (!voice) return;
    for (const s of data.sentences) if (s.status === DROPPED) voice.playback.skip(s.utteranceId, s.idx);
  }, [voice, data.sentences]);

  // Phrase ids stay unique across reloads.
  const maxPhraseId = data.phrases.reduce((m, p) => Math.max(m, p.phraseId), 0);
  useEffect(() => {
    voice?.setNextPhraseId(maxPhraseId + 1);
  }, [voice, maxPhraseId]);

  // Stop the microphone when leaving the screen.
  useEffect(
    () => () => {
      void voiceRef.current?.stop();
      voiceRef.current = null;
    },
    []
  );

  const onSentenceStart = useCallback((u: bigint, idx: number) => {
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

  const startTalking = async () => {
    setError('');
    setStarting(true);
    try {
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
      eventLog.log('ui.start_talking', {});
      await v.start();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      eventLog.log('ui.start_failed', { error: msg });
      setError(`Could not start the microphone: ${msg}`);
      await voiceRef.current?.stop();
      voiceRef.current = null;
      setVoice(null);
    } finally {
      setStarting(false);
    }
  };

  const stopTalking = async () => {
    window.__tutor.voice = undefined;
    await voiceRef.current?.stop();
    voiceRef.current = null;
    setVoice(null);
  };

  const endSession = async () => {
    await stopTalking();
    const r = await callReducer('endSession', { sessionId }, () => conn.reducers.endSession({ sessionId }));
    if (!r.ok) setError(r.error ?? 'failed');
  };

  const submitAnswer = async (boardItemId: bigint, answer: string) => {
    const r = await callReducer('submitGapAnswer', { boardItemId, answer }, () => conn.reducers.submitGapAnswer({ boardItemId, answer }));
    if (!r.ok) setError(r.error ?? 'failed');
  };

  const tutorShown = useCallback(
    (s: ReplySentence) => s.status === PLAYED || (localStarted.get(s.utteranceId.toString()) ?? []).includes(s.idx),
    [localStarted]
  );

  if (data.error) return <ErrorNote>Subscription failed: {data.error}</ErrorNote>;
  if (data.ready && !session) {
    return (
      <div data-testid="session-missing" className="py-16 text-center text-sm text-muted-foreground">
        Session {sessionId.toString()} does not exist.
      </div>
    );
  }

  const liveCaption = [...data.sentences].filter(tutorShown).sort((a, b) => Number(a.id - b.id)).at(-1)?.display;
  const stateLabel = !session?.active ? 'Session finished' : ui.tutorAudio ? 'Listen and watch' : session.turnState === 'thinking' ? 'Thinking it through…' : ui.speaking ? 'I’m listening' : voice ? 'Your turn' : 'Ready when you are';
  return (
    <div data-testid="session-screen" data-session-id={sessionId.toString()} className={`lesson-studio ${conversationOpen ? '' : 'conversation-hidden'}`}>
      <div className="lesson-topline">
        <div className="lesson-question">
          <span className="studio-eyebrow">Our question</span>
          <h1 data-testid="task-display">{session?.taskText || 'What would you like to understand?'}</h1>
        </div>
        <button className="conversation-toggle" aria-expanded={conversationOpen} aria-controls="lesson-conversation" onClick={() => setConversationOpen(v => !v)}>
          {conversationOpen ? 'Hide conversation' : 'Show conversation'}
        </button>
      </div>
      <ErrorNote>{error}</ErrorNote>
      <div className="lesson-layout">
        <section className="lesson-stage" aria-label="Learning canvas">
          <div className="stage-topline"><span className="studio-eyebrow">Work it out</span><span className="stage-status" role="status"><i data-active={!!voice} />{stateLabel}</span></div>
          <div className="lesson-picture">
            <Board items={data.boardItems} progress={progress} serverOver={serverOver} onSubmitAnswer={submitAnswer} allowCanvasInteraction={!!session?.active && session.turnState === 'listening' && !ui.tutorAudio} />
          </div>
          <div className="stage-caption" aria-live="off">{liveCaption || 'Tell me what feels confusing. We’ll make it visible here.'}</div>
          <footer className="stage-controls">
            <div className="voice-control">
              {session && !session.active ? <Button size="lg" onClick={() => navigate(homeUrl())}>Start another question</Button> : !voice ? <Button size="lg" data-testid="start-talking" onClick={startTalking} disabled={starting || !session?.active}>
                <MicIcon />{starting ? 'Starting…' : APP_CONFIG.startButtonText}
              </Button> : <Button size="lg" variant="outline" data-testid="stop-talking" onClick={stopTalking}><MicIcon />Pause microphone</Button>}
              {voice && <MicMeter ui={ui} />}
            </div>
            <p data-testid="headphones-hint">{session && !session.active ? 'Your picture and conversation are saved.' : ui.noise === 'noisy' ? APP_CONFIG.noisyHint : voice ? 'Think aloud. You can interrupt at any time.' : 'Headphones help us hear each other.'}</p>
          </footer>
        </section>
        <aside id="lesson-conversation" className="lesson-conversation" hidden={!conversationOpen} aria-label="Conversation">
          <div className="conversation-heading"><h2>Conversation</h2><span>{data.learner?.name || 'You'} + tutor</span></div>
          <Captions data={data} tutorShown={tutorShown} />
          <details className="lesson-details">
            <summary>Lesson details</summary>
            <div className="lesson-details-content">
              <SessionTitle data={data} />
              <PhotoUpload conn={conn} sessionId={sessionId} hasImage={!!session?.hasImage} />
              <a data-testid="open-observer" href={sessionUrl('observe', sessionId)} target="_blank" rel="noreferrer">Open observer</a>
              <Button variant="ghost" size="sm" data-testid="end-session" onClick={endSession} disabled={!session?.active}>Finish session</Button>
            </div>
          </details>
        </aside>
      </div>
      {debugOpen && <><Indicators data={data} noise={{ state: ui.noise, floorDb: ui.floorDb }} /><DebugPanel data={data} localLatency={localLatency} /></>}
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
