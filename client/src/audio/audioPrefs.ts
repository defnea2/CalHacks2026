// Audio device + level preferences (settings popover): microphone, speaker, input gain, output
// volume. Persisted per browser in localStorage; every access is guarded (private windows,
// blocked storage). Pure helpers here, the Web Audio side lives in AudioCapture / VoiceSession.

export interface AudioPrefs {
  /** audioinput deviceId; '' = browser default. */
  micId: string;
  /** audiooutput deviceId; '' = browser default. */
  speakerId: string;
  /** GainNode before the VAD / encoder. */
  inputGain: number;
  /** Tutor playback volume (0..1). */
  outputVolume: number;
}

export const INPUT_GAIN_MIN = 0.5;
export const INPUT_GAIN_MAX = 4;
export const DEFAULT_PREFS: AudioPrefs = { micId: '', speakerId: '', inputGain: 1, outputVolume: 1 };
export const PREFS_KEY = 'tutor.audioPrefs';

type Store = Pick<Storage, 'getItem' | 'setItem'>;

function storage(): Store | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

const num = (v: unknown, lo: number, hi: number, d: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);

export function clampInputGain(v: number): number {
  return num(v, INPUT_GAIN_MIN, INPUT_GAIN_MAX, 1);
}

export function clampVolume(v: number): number {
  return num(v, 0, 1, 1);
}

export function loadPrefs(store: Store | null = storage()): AudioPrefs {
  try {
    const raw = store?.getItem(PREFS_KEY);
    if (!raw) return { ...DEFAULT_PREFS };
    const p = JSON.parse(raw) as Partial<AudioPrefs>;
    return {
      micId: typeof p.micId === 'string' ? p.micId : '',
      speakerId: typeof p.speakerId === 'string' ? p.speakerId : '',
      inputGain: clampInputGain(p.inputGain as number),
      outputVolume: clampVolume(p.outputVolume as number),
    };
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

export function savePrefs(patch: Partial<AudioPrefs>, store: Store | null = storage()): AudioPrefs {
  const next = { ...loadPrefs(store), ...patch };
  try {
    store?.setItem(PREFS_KEY, JSON.stringify(next));
  } catch {
    /* storage blocked: the choice still applies for this page */
  }
  return next;
}

/** getUserMedia audio constraints: the chosen device (exact) on top of the processing flags. */
export function micConstraints(base: MediaTrackConstraints, micId: string): MediaTrackConstraints {
  return micId ? { ...base, deviceId: { exact: micId } } : { ...base };
}

export interface DeviceLike {
  deviceId: string;
  kind: string;
  label: string;
}

/** After a devicechange: is the chosen device still there? '' (default) always is. */
export function deviceAvailable(devices: DeviceLike[], kind: 'audioinput' | 'audiooutput', id: string): boolean {
  return !id || devices.some(d => d.kind === kind && d.deviceId === id);
}

/** Devices of one kind for a select; the pseudo-ids 'default' / 'communications' are folded into "System default". */
export function deviceOptions(devices: DeviceLike[], kind: 'audioinput' | 'audiooutput'): { id: string; label: string }[] {
  const out: { id: string; label: string }[] = [{ id: '', label: 'System default' }];
  let n = 0;
  for (const d of devices) {
    if (d.kind !== kind || !d.deviceId || d.deviceId === 'default' || d.deviceId === 'communications') continue;
    n += 1;
    out.push({ id: d.deviceId, label: d.label || `${kind === 'audioinput' ? 'Microphone' : 'Speaker'} ${n}` });
  }
  return out;
}

/** AudioContext.setSinkId (Chrome/Edge 110+); absent in Safari and Firefox. */
export function sinkSelectable(ctx: unknown): ctx is { setSinkId(id: string): Promise<void> } {
  return !!ctx && typeof (ctx as { setSinkId?: unknown }).setSinkId === 'function';
}

/** Mic level meter: dBFS → 0..1 (-60 dB → 0, -10 dB → 1). */
export function levelFraction(db: number): number {
  return Math.min(1, Math.max(0, (db + 60) / 50));
}

/** getUserMedia failure → one sentence for the learner. */
export function micErrorMessage(err: unknown): string {
  const name = (err as { name?: string } | null)?.name ?? '';
  if (name === 'NotAllowedError' || name === 'SecurityError') return 'The microphone is blocked. Allow it in the browser (the icon in the address bar), then try again.';
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'No microphone found. Plug one in, then try again.';
  if (name === 'NotReadableError' || name === 'AbortError') return 'The microphone is busy in another app. Close it there, then try again.';
  const msg = err instanceof Error ? err.message : String(err);
  return `Could not start the microphone (${msg}).`;
}
