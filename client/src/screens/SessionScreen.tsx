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
import { Button, Card, CardHeader, ErrorNote } from '../components/ui';
import { APP_CONFIG } from '../app-config';
import { compressPhoto } from '../lib/photo';
import { eventLog } from '../lib/debug';
import { navigate, sessionUrl } from '../lib/format';
import { shouldStartConversation } from '../lib/conversation';

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

  const tutorShown = useCallback(
    (s: ReplySentence) => s.status === PLAYED || (localStarted.get(s.utteranceId.toString()) ?? -1) >= s.idx,
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

  return (
    <div data-testid="session-screen" data-session-id={sessionId.toString()} className="flex flex-col gap-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex flex-col gap-2">
          <SessionTitle data={data} />
          <Indicators data={data} noise={{ state: ui.noise, floorDb: ui.floorDb }} />
        </div>
        <div className="flex items-center gap-2">
          <a
            data-testid="open-observer"
            href={sessionUrl('observe', sessionId)}
            target="_blank"
            rel="noreferrer"
            className="text-sm text-muted-foreground underline-offset-4 hover:underline"
          >
            Open observer
          </a>
          <Button variant="outline" size="sm" data-testid="end-session" onClick={endSession} disabled={!session?.active}>
            End session
          </Button>
        </div>
      </div>

      <ErrorNote>{error}</ErrorNote>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
        <div className="flex flex-col gap-6">
          <Card>
            <CardHeader title="Your task" />
            <div className="flex flex-col gap-3 p-4">
              <p data-testid="task-display" className="whitespace-pre-wrap">
                {session?.taskText || <span className="text-muted-foreground">No task text.</span>}
              </p>
              <PhotoUpload conn={conn} sessionId={sessionId} hasImage={!!session?.hasImage} />
            </div>
          </Card>

          <Card>
            <div className="flex flex-col items-center gap-3 p-6">
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
              <p data-testid="headphones-hint" className="text-center text-xs text-muted-foreground">
                {APP_CONFIG.headphonesHint}
              </p>
              {ui.noise === 'noisy' ? (
                <p data-testid="noise-hint" className="rounded-lg bg-amber-100 px-3 py-2 text-center text-sm text-amber-900 dark:bg-amber-900/40 dark:text-amber-100">
                  {APP_CONFIG.noisyHint}
                </p>
              ) : null}
            </div>
          </Card>

          <Card>
            <CardHeader title="Conversation" />
            <Captions data={data} tutorShown={tutorShown} />
          </Card>
        </div>

        <Card>
          <CardHeader title="Board" />
          <div className="p-4">
            <Board items={data.boardItems} progress={progress} serverOver={serverOver} onSubmitAnswer={submitAnswer} />
          </div>
        </Card>
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
    <div className="flex flex-col items-center gap-2" data-testid="mic-state" data-listening={ui.listening} data-speaking={ui.speaking} data-tutor-audio={ui.tutorAudio}>
      <div className={`flex size-16 items-center justify-center rounded-full border-2 transition-colors ${ui.speaking ? 'border-emerald-500 bg-emerald-500/10' : ui.tutorAudio ? 'border-sky-500 bg-sky-500/10' : 'border-border'}`}>
        <span className="text-xs font-medium">{ui.speaking ? 'You' : ui.tutorAudio ? 'Tutor' : ui.listening ? 'Listening' : '…'}</span>
      </div>
      <div className="h-1.5 w-40 overflow-hidden rounded-full bg-muted">
        <div className="h-full bg-foreground/60 transition-[width] duration-100" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
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
