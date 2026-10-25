// Wires AudioCapture + PlaybackQueue to SpacetimeDB for one session (Transport = reducers up,
// subscriptions down). Created when the session screen opens (right after the "Start my lesson"
// click, whose user activation lets the AudioContext run); mic + playback start at once.
// Device / level settings (popover): see audioPrefs.ts and AudioDevices below.
import type { DbConnection } from '../module_bindings';
import type { AudioOut, PlaybackFlush } from '../module_bindings/types';
import type { AppSettings } from '../config';
import { AudioCapture } from './AudioCapture';
import { PlaybackQueue } from './PlaybackQueue';
import { AudioUnlock } from './audioUnlock';
import { floatToPcm16 } from './pcm';
import { deviceAvailable, loadPrefs, savePrefs, sinkSelectable, clampInputGain, clampVolume, type AudioPrefs } from './audioPrefs';
import type { VadEvent } from './vadMachine';
import type { NoiseState } from './noise';
import { callReducer } from '../stdb/connection';
import { eventLog } from '../lib/debug';
import type { SentenceTiming } from '../board/reveal';

export interface VoiceUiState {
  listening: boolean;
  speaking: boolean;
  tutorAudio: boolean;
  noise: NoiseState;
  floorDb: number | null;
  levelDb: number;
  prob: number;
  /** AudioContext still not running after a resume attempt (autoplay blocked): show "Tap for sound". */
  audioBlocked?: boolean;
  /** Short notice after a device change (e.g. "Microphone unplugged: using the default"). */
  deviceNotice?: string;
}

/** What the settings popover drives (VoiceSession, or the ?miccheck capture). */
export interface AudioDevices {
  readonly prefs: AudioPrefs;
  /** Speaker choice works only with AudioContext.setSinkId (Chrome/Edge). */
  readonly canSelectSpeaker: boolean;
  setMic(id: string): Promise<void>;
  setSpeaker(id: string): Promise<void>;
  setInputGain(v: number): void;
  setOutputVolume(v: number): void;
}

export interface VoiceSessionOptions {
  conn: DbConnection;
  sessionId: bigint;
  settings: AppSettings;
  firstPhraseId: number;
  onUi: (s: Partial<VoiceUiState>) => void;
  onSentenceStart: (utteranceId: bigint, idx: number, timing: SentenceTiming) => void;
  onTurnEnd?: (wallMs: number) => void;
}

export class VoiceSession implements AudioDevices {
  readonly ctx: AudioContext;
  prefs: AudioPrefs = loadPrefs();
  readonly playback: PlaybackQueue;
  private capture: AudioCapture | null = null;
  private serverSpeaking = false;
  private serverUtterance = 0n;
  private lastUiFrame = 0;
  private stopped = false;
  private readonly unlock: AudioUnlock;
  private readonly onAudio = (_c: unknown, row: AudioOut) => {
    if (row.sessionId !== this.o.sessionId) return;
    this.unlock.poke(); // a suspended context would stall playback forever
    this.playback.push({
      utteranceId: row.utteranceId,
      idx: row.idx,
      pcm: row.pcm,
      sampleRate: row.sampleRate,
      wordStartsMs: row.wordStartsMs,
      wordEndsMs: row.wordEndsMs,
    });
  };
  private readonly onFlush = (_c: unknown, row: PlaybackFlush) => {
    if (row.sessionId !== this.o.sessionId) return;
    this.playback.flush(row.utteranceId, 'playback_flush');
  };

  constructor(private readonly o: VoiceSessionOptions) {
    // Must run inside the click handler (autoplay policy).
    this.ctx = new AudioContext({ latencyHint: 'interactive' });
    this.unlock = new AudioUnlock(this.ctx, blocked => {
      eventLog.log('audio.blocked', { blocked, state: this.ctx.state });
      o.onUi({ audioBlocked: blocked });
    });
    this.unlock.poke();
    eventLog.log('audio.context', { sampleRate: this.ctx.sampleRate, state: this.ctx.state });
    this.playback = new PlaybackQueue(this.ctx, o.settings.playback, o.settings.client, {
      onSentenceStart: (u, idx, timing) => {
        o.onSentenceStart(u, idx, timing);
        const args = { sessionId: o.sessionId, utteranceId: u, idx };
        void callReducer('markPlayed', args, () => o.conn.reducers.markPlayed(args));
      },
      onPlayingChange: playing => {
        o.onUi({ tutorAudio: playing });
        this.updateTutorSpeaking();
      },
    });
    this.playback.setVolume(this.prefs.outputVolume);
    if (this.prefs.speakerId) void this.setSpeaker(this.prefs.speakerId, false);
    o.conn.db.audioOut.onInsert(this.onAudio);
    o.conn.db.playbackFlush.onInsert(this.onFlush);
    navigator.mediaDevices?.addEventListener?.('devicechange', this.onDeviceChange);
  }

  // ------------------------------------------------------------ devices (settings popover)
  get canSelectSpeaker(): boolean {
    return sinkSelectable(this.ctx);
  }

  async setMic(id: string): Promise<void> {
    this.prefs = savePrefs({ micId: id });
    this.o.onUi({ deviceNotice: '' });
    await this.capture?.switchMic(id);
  }

  async setSpeaker(id: string, save = true): Promise<void> {
    if (save) this.prefs = savePrefs({ speakerId: id });
    if (!sinkSelectable(this.ctx)) return;
    try {
      await this.ctx.setSinkId(id);
      eventLog.log('audio.sink', { deviceId: id });
    } catch (err) {
      eventLog.log('audio.sink_error', { deviceId: id, error: String(err) });
      if (id) await this.ctx.setSinkId('').catch(() => {});
    }
  }

  setInputGain(v: number): void {
    this.prefs = savePrefs({ inputGain: clampInputGain(v) });
    this.capture?.setInputGain(this.prefs.inputGain);
  }

  setOutputVolume(v: number): void {
    this.prefs = savePrefs({ outputVolume: clampVolume(v) });
    this.playback.setVolume(this.prefs.outputVolume);
  }

  /** A chosen device disappeared: fall back to the default and say so. */
  private readonly onDeviceChange = async () => {
    if (this.stopped) return;
    let devices: MediaDeviceInfo[];
    try {
      devices = await navigator.mediaDevices.enumerateDevices();
    } catch {
      return;
    }
    if (!deviceAvailable(devices, 'audioinput', this.prefs.micId)) {
      eventLog.log('audio.mic_lost', { deviceId: this.prefs.micId });
      await this.setMic('').catch(err => eventLog.log('audio.mic_fallback_failed', { error: String(err) }));
      this.o.onUi({ deviceNotice: 'Microphone unplugged: using the default microphone.' });
    }
    if (!deviceAvailable(devices, 'audiooutput', this.prefs.speakerId)) {
      eventLog.log('audio.speaker_lost', { deviceId: this.prefs.speakerId });
      await this.setSpeaker('');
      this.o.onUi({ deviceNotice: 'Speaker unplugged: using the default speaker.' });
    }
  };

  async start(): Promise<void> {
    if (this.stopped || this.capture) return;
    this.capture = new AudioCapture({
      ctx: this.ctx,
      settings: this.o.settings,
      firstPhraseId: this.o.firstPhraseId,
      micId: this.prefs.micId,
      inputGain: this.prefs.inputGain,
      onTrackEnded: () => void this.onDeviceChange(),
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
    const c = this.capture;
    try {
      await c.start();
    } catch (err) {
      // The chosen microphone may be gone: one more try with the default before giving up.
      const name = (err as { name?: string } | null)?.name;
      if (!this.prefs.micId || (name !== 'OverconstrainedError' && name !== 'NotFoundError')) {
        if (this.capture === c) this.capture = null;
        await c.stop().catch(() => {});
        throw err;
      }
      await c.stop().catch(() => {});
      this.prefs = savePrefs({ micId: '' });
      this.o.onUi({ deviceNotice: 'The chosen microphone is not available: using the default.' });
      if (this.capture === c) this.capture = null;
      return this.start();
    }
    if (this.stopped || this.capture !== c) {
      await c.stop(); // stopped (or muted) while the microphone was opening
      return;
    }
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
        void callReducer('pushAudio', args, () => conn.reducers.pushAudio(args));
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
        eventLog.log('vad.turn_end', { noiseDb: e.noiseDb, reason: e.reason, silenceMs: Math.round(e.silenceMs) });
        void callReducer('endTurn', { sessionId }, () => conn.reducers.endTurn({ sessionId }));
        // once per turn: the noise floor for turn_metrics.noiseDb
        const noiseArgs = { sessionId, noiseDb: e.noiseDb ?? -100 };
        void callReducer('reportNoise', noiseArgs, () => conn.reducers.reportNoise(noiseArgs));
        this.o.onTurnEnd?.(wall);
        break;
      }
      case 'barge_in': {
        eventLog.log('vad.barge_in', { speechMs: Math.round(e.speechMs) });
        // Utterance-scoped: the one this tab is playing. The server already moved on when its LAST
        // sentence started (currentUtteranceId 0), so a plain interrupt would miss it.
        const utteranceId = this.playback.playingUtterance || this.serverUtterance;
        this.playback.flush(undefined, 'barge_in');
        // the utterance the server is on may not have sent audio yet: never play it later
        if (this.serverUtterance !== 0n) this.playback.flush(this.serverUtterance, 'barge_in');
        const args = { sessionId, utteranceId };
        void callReducer('interruptUtterance', args, () => conn.reducers.interruptUtterance(args));
        break;
      }
      case 'misfire':
        eventLog.log('vad.misfire', { speechMs: Math.round(e.speechMs) });
        break;
      case 'noise_state':
        eventLog.log('noise.state', { state: e.state, floorDb: e.floorDb === null ? null : Math.round(e.floorDb * 10) / 10 });
        this.o.onUi({ noise: e.state, floorDb: e.floorDb });
        break;
    }
  }

  /** "Tap for sound": resume the AudioContext from a user gesture. */
  resumeAudio(): void {
    this.unlock.poke();
  }

  get capturing(): boolean {
    return this.capture !== null;
  }

  /** Microphone muted (capture stopped, tracks released), tutor audio keeps playing. */
  async stopCapture(): Promise<void> {
    const c = this.capture;
    this.capture = null;
    await c?.stop();
    this.o.onUi({ listening: false, speaking: false });
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    await this.capture?.stop();
    this.o.conn.db.audioOut.removeOnInsert(this.onAudio);
    this.o.conn.db.playbackFlush.removeOnInsert(this.onFlush);
    navigator.mediaDevices?.removeEventListener?.('devicechange', this.onDeviceChange);
    this.playback.destroy();
    this.unlock.destroy();
    await this.ctx.close().catch(() => {});
    this.o.onUi({ listening: false, speaking: false, tutorAudio: false });
  }
}
