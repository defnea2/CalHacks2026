// Screen 2: the live session (?session=<id>; a reload resumes it).
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DbConnection } from '../module_bindings';
import type { ReplySentence } from '../module_bindings/types';
import type { AppSettings } from '../config';
import { useSessionData } from '../stdb/useSessionData';
import { callReducer } from '../stdb/connection';
import { VoiceSession, type VoiceUiState } from '../audio/VoiceSession';
import { Board, type BoardItemView } from '../board/Board';
import { markerOffsetMs, type SentenceTiming } from '../board/reveal';
import { Captions, DebugPanel, Indicators, SessionTitle, useUtteranceState } from '../components/session';
import { Button, ErrorNote } from '../components/ui';
import { APP_CONFIG } from '../app-config';
import { compressPhoto } from '../lib/photo';
import { eventLog } from '../lib/debug';
import { navigate, sessionUrl } from '../lib/format';
import { shouldStartConversation } from '../lib/conversation';
import { Buddy } from '../design/Buddy';

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
  const [localStarted, setLocalStarted] = useState<Map<string, number>>(() => new Map());
  /** Playback timing of the sentences this tab started ("utteranceId:idx"), for marker reveals. */
  const timings = useRef(new Map<string, SentenceTiming>());
  const [localLatency, setLocalLatency] = useState<Map<number, number>>(() => new Map());
  const lastTurnEnd = useRef<number | null>(null);
  const turnCounter = useRef(0);
  const debugOpen = new URLSearchParams(window.location.search).get('debug') !== '0' && APP_CONFIG.debugOpen;

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
    st.boardItems = data.boardItems.map(b => ({ id: b.id.toString(), idx: b.idx, kind: b.kind, visible: b.visible, utteranceId: b.utteranceId.toString(), sentenceIdx: b.sentenceIdx, markerPos: b.markerPos, answerState: b.answerState }));
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

  const onSentenceStart = useCallback((u: bigint, idx: number, timing: SentenceTiming) => {
    timings.current.set(`${u}:${idx}`, timing);
    setLocalStarted(prev => {
      const k = u.toString();
      if ((prev.get(k) ?? -1) >= idx) return prev;
      const next = new Map(prev);
      next.set(k, idx);
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

  // Inline board markers: the item appears when its marker word plays.
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

  const tutorShown = useCallback(
    (s: ReplySentence) => s.status === PLAYED || (localStarted.get(s.utteranceId.toString()) ?? -1) >= s.idx,
    [localStarted]
  );

  if (data.error) return <ErrorNote>Subscription failed: {data.error}</ErrorNote>;
  if (data.ready && !session) {
    return (
      <div data-testid="session-missing" className="voice-empty">
        Session {sessionId.toString()} does not exist.
      </div>
    );
  }

  return (
    <div data-testid="session-screen" data-session-id={sessionId.toString()} className="lesson-view" data-stage={ui.speaking ? 'practice' : 'teaching'}>
      <div className="lesson-topline">
          <a
            data-testid="open-observer"
            href={sessionUrl('observe', sessionId)}
            target="_blank"
            rel="noreferrer"
            className="lesson-back"
          >
            Open observer
          </a>
          <Button variant="outline" size="sm" data-testid="end-session" onClick={endSession} disabled={!session?.active}>
            End session
          </Button>
      </div>
      <div className="lesson-title"><SessionTitle data={data} /></div>
      <Indicators data={data} noise={{ state: ui.noise, floorDb: ui.floorDb }} />

      <ErrorNote>{error}</ErrorNote>

      <div className="lesson-stage">
        <div className="lesson-paper">
          <div className="voice-task">
            <span>Your task</span>
            <p data-testid="task-display">{session?.taskText || 'No task text.'}</p>
          </div>
          <section className="teaching-canvas voice-board-stage" aria-label="Board">
            <div className="canvas-heading"><span>Board</span><span className="canvas-interaction-hint">Pictures appear as the tutor speaks</span></div>
            <Board items={data.boardItems} progress={progress} serverOver={serverOver} onSubmitAnswer={submitAnswer} markerAt={markerAt} />
          </section>
          <div className="mt-4"><PhotoUpload conn={conn} sessionId={sessionId} hasImage={!!session?.hasImage} /></div>
        </div>

        <aside className="lesson-conversation" aria-label="Tutor conversation">
            <div className="voice-mic">
              {!voice ? (
                <Button size="lg" data-testid="start-talking" onClick={startTalking} disabled={starting || !session?.active}>
                  {starting ? 'Starting…' : APP_CONFIG.startButtonText}
                </Button>
              ) : (
                <div className="flex flex-col items-center gap-3">
                  <MicMeter ui={ui} />
                  <Button variant="secondary" data-testid="stop-talking" onClick={stopTalking}>
                    {APP_CONFIG.stopButtonText}
                  </Button>
                </div>
              )}
              <p data-testid="headphones-hint" className="voice-hint">
                {APP_CONFIG.headphonesHint}
              </p>
              {ui.noise === 'noisy' ? (
                <p data-testid="noise-hint" className="voice-hint is-noisy">
                  {APP_CONFIG.noisyHint}
                </p>
              ) : null}
            </div>
            <div className="lesson-turn-label"><span>Conversation</span></div>
            <Captions data={data} tutorShown={tutorShown} />
        </aside>
      </div>

      {debugOpen ? <DebugPanel data={data} localLatency={localLatency} /> : null}
      {session && !session.active ? (
        <Button variant="outline" onClick={() => navigate(window.location.pathname)}>
          Back to learners
        </Button>
      ) : null}
    </div>
  );
}

function MicMeter({ ui }: { ui: VoiceUiState }) {
  const pct = Math.max(0, Math.min(100, ((ui.levelDb + 70) / 60) * 100));
  return (
    <div className="voice-mic" data-testid="mic-state" data-listening={ui.listening} data-speaking={ui.speaking} data-tutor-audio={ui.tutorAudio}>
      {/* Pip shows who has the floor: the tutor, the learner, or nobody yet. */}
      <div className="voice-mic-ring" data-who={ui.speaking ? 'you' : ui.tutorAudio ? 'tutor' : 'none'}>
        <Buddy size={66} />
      </div>
      <span className="voice-mic-who">{ui.speaking ? 'You' : ui.tutorAudio ? 'Tutor' : ui.listening ? 'Listening' : '…'}</span>
      <div className="voice-mic-level"><i style={{ width: `${pct}%` }} /></div>
    </div>
  );
}

function PhotoUpload({ conn, sessionId, hasImage }: { conn: DbConnection; sessionId: bigint; hasImage: boolean }) {
  const [state, setState] = useState<'idle' | 'busy' | 'done' | 'error'>('idle');
  const [msg, setMsg] = useState('');
  if (hasImage) return <p data-testid="photo-state" data-state="uploaded" className="voice-note">Photo attached.</p>;
  return (
    <label className="voice-label">
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
      />
      {msg ? <span data-testid="photo-state" data-state={state}>{msg}</span> : null}
    </label>
  );
}
