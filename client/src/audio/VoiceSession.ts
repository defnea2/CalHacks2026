// Wires AudioCapture + PlaybackQueue to SpacetimeDB for one session (Transport = reducers up,
// subscriptions down). Created on the "Start talking" click, which also creates the AudioContext.
import type { DbConnection } from '../module_bindings';
import type { AudioOut, PlaybackFlush } from '../module_bindings/types';
import type { AppSettings } from '../config';
import { AudioCapture } from './AudioCapture';
import { PlaybackQueue } from './PlaybackQueue';
import { floatToPcm16 } from './pcm';
import type { VadEvent } from './vadMachine';
import type { NoiseState } from './noise';
import { callReducer } from '../stdb/connection';
import { eventLog } from '../lib/debug';

export interface VoiceUiState {
  listening: boolean;
  speaking: boolean;
  tutorAudio: boolean;
  noise: NoiseState;
  floorDb: number | null;
  levelDb: number;
  prob: number;
}

export interface VoiceSessionOptions {
  conn: DbConnection;
  sessionId: bigint;
  settings: AppSettings;
  firstPhraseId: number;
  onUi: (s: Partial<VoiceUiState>) => void;
  onSentenceStart: (utteranceId: bigint, idx: number) => void;
  onTurnEnd?: (wallMs: number) => void;
}

export class VoiceSession {
  readonly ctx: AudioContext;
  readonly playback: PlaybackQueue;
  private capture: AudioCapture | null = null;
  private serverSpeaking = false;
  private serverUtterance = 0n;
  private lastUiFrame = 0;
  private stopped = false;
  private readonly onAudio = (_c: unknown, row: AudioOut) => {
    if (row.sessionId !== this.o.sessionId) return;
    eventLog.log('lat.audioIn', { utteranceId: row.utteranceId.toString(), idx: row.idx, bytes: row.pcm.length });
    this.playback.push({ utteranceId: row.utteranceId, idx: row.idx, pcm: row.pcm, sampleRate: row.sampleRate });
  };
  private readonly onFlush = (_c: unknown, row: PlaybackFlush) => {
    if (row.sessionId !== this.o.sessionId) return;
    this.playback.flush(row.utteranceId, 'playback_flush');
  };

  constructor(private readonly o: VoiceSessionOptions) {
    // Must run inside the click handler (autoplay policy).
    this.ctx = new AudioContext({ latencyHint: 'interactive' });
    void this.ctx.resume();
    eventLog.log('audio.context', { sampleRate: this.ctx.sampleRate, state: this.ctx.state });
    this.playback = new PlaybackQueue(this.ctx, o.settings.playback, o.settings.client, {
      onSentenceStart: (u, idx) => {
        o.onSentenceStart(u, idx);
        const args = { sessionId: o.sessionId, utteranceId: u, idx };
        void callReducer('markPlayed', args, () => o.conn.reducers.markPlayed(args));
      },
      onPlayingChange: playing => {
        o.onUi({ tutorAudio: playing });
        this.updateTutorSpeaking();
      },
    });
    o.conn.db.audioOut.onInsert(this.onAudio);
    o.conn.db.playbackFlush.onInsert(this.onFlush);
  }

  async start(): Promise<void> {
    this.capture = new AudioCapture({
      ctx: this.ctx,
      settings: this.o.settings,
      firstPhraseId: this.o.firstPhraseId,
      onEvent: e => this.onVad(e),
      onFrame: (levelDb, prob) => {
        const now = performance.now();
        if (now - this.lastUiFrame > 100) {
          this.lastUiFrame = now;
          this.o.onUi({ levelDb, prob, floorDb: this.capture?.machine.noise.floorDb ?? null });
        }
      },
    });
    this.updateTutorSpeaking();
    await this.capture.start();
    this.o.onUi({ listening: true });
  }

  /** Session turnState from the server ('speaking' raises the VAD threshold too). */
  setServerSpeaking(v: boolean, currentUtteranceId: bigint): void {
    this.serverSpeaking = v;
    this.serverUtterance = currentUtteranceId;
    this.updateTutorSpeaking();
  }

  setNextPhraseId(id: number): void {
    this.capture?.machine.setNextPhraseId(id);
  }

  private updateTutorSpeaking(): void {
    const v = this.serverSpeaking || this.playback.isPlaying;
    if (this.capture && this.capture.machine.tutorSpeaking !== v) {
      this.capture.tutorSpeaking = v;
      eventLog.log('vad.tutor_speaking', { value: v });
    }
  }

  private onVad(e: VadEvent): void {
    const { conn, sessionId } = this.o;
    switch (e.type) {
      case 'chunk': {
        const pcm = floatToPcm16(e.pcm);
        const args = { sessionId, phraseId: e.phraseId, seq: e.seq, pcm, final: e.final };
        eventLog.log('vad.chunk', { phraseId: e.phraseId, seq: e.seq, ms: Math.round(e.pcm.length / 16), final: e.final });
        // TEMPORARY latency instrumentation: per-chunk reducer round trip with wall clock.
        const t0 = performance.now();
        const wall0 = Date.now();
        void callReducer('pushAudio', args, () => conn.reducers.pushAudio(args)).then(() =>
          eventLog.log('lat.push', { phraseId: e.phraseId, seq: e.seq, final: e.final, bytes: pcm.length, wall0, ms: Math.round((performance.now() - t0) * 100) / 100 })
        );
        break;
      }
      case 'speech_start':
        eventLog.log('vad.speech_start', { phraseId: e.phraseId, bargeIn: e.bargeIn, prerollMs: Math.round(e.prerollMs) });
        this.o.onUi({ speaking: true });
        break;
      case 'phrase_end':
        eventLog.log('vad.phrase_end', { phraseId: e.phraseId, durationMs: Math.round(e.durationMs), reason: e.reason });
        this.o.onUi({ speaking: false });
        break;
      case 'turn_end': {
        const wall = Date.now();
        eventLog.log('vad.turn_end', { noiseDb: e.noiseDb });
        void callReducer('endTurn', { sessionId }, () => conn.reducers.endTurn({ sessionId }));
        // once per turn: the noise floor for turn_metrics.noiseDb
        const noiseArgs = { sessionId, noiseDb: e.noiseDb ?? -100 };
        void callReducer('reportNoise', noiseArgs, () => conn.reducers.reportNoise(noiseArgs));
        this.o.onTurnEnd?.(wall);
        break;
      }
      case 'barge_in':
        eventLog.log('vad.barge_in', { speechMs: Math.round(e.speechMs) });
        this.playback.flush(undefined, 'barge_in');
        // the utterance the server is on may not have sent audio yet: never play it later
        if (this.serverUtterance !== 0n) this.playback.flush(this.serverUtterance, 'barge_in');
        void callReducer('interrupt', { sessionId }, () => conn.reducers.interrupt({ sessionId }));
        break;
      case 'misfire':
        eventLog.log('vad.misfire', { speechMs: Math.round(e.speechMs) });
        break;
      case 'noise_state':
        eventLog.log('noise.state', { state: e.state, floorDb: e.floorDb === null ? null : Math.round(e.floorDb * 10) / 10 });
        this.o.onUi({ noise: e.state, floorDb: e.floorDb });
        break;
    }
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    await this.capture?.stop();
    this.o.conn.db.audioOut.removeOnInsert(this.onAudio);
    this.o.conn.db.playbackFlush.removeOnInsert(this.onFlush);
    this.playback.destroy();
    await this.ctx.close().catch(() => {});
    this.o.onUi({ listening: false, speaking: false, tutorAudio: false });
  }
}
