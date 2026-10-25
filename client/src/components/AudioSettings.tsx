// Audio settings popover (gear icon), like a video call's device picker: microphone, speaker
// (only where AudioContext.setSinkId exists), a live input level meter, input gain (before the
// VAD) and output volume. Choices persist in localStorage (audioPrefs.ts); changes apply live.
import { useEffect, useRef, useState } from 'react';
import type { AudioDevices } from '../audio/VoiceSession';
import { INPUT_GAIN_MAX, INPUT_GAIN_MIN, deviceOptions, levelFraction, type DeviceLike } from '../audio/audioPrefs';
import '../audioSettings.css';

export interface AudioSettingsProps {
  devices: AudioDevices | null;
  /** Latest input level in dBFS (after the gain), for the meter. */
  levelDb: number;
  /** Microphone running (the meter is idle otherwise). */
  live: boolean;
  /** Opens upwards (session controls at the bottom) or downwards. */
  placement?: 'up' | 'down';
}

export function AudioSettings({ devices, levelDb, live, placement = 'up' }: AudioSettingsProps) {
  const [open, setOpen] = useState(false);
  const [list, setList] = useState<DeviceLike[]>([]);
  const [, force] = useState(0);
  const [error, setError] = useState('');
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const md = navigator.mediaDevices;
    const refresh = () => void md?.enumerateDevices?.().then(setList, () => setList([]));
    refresh();
    md?.addEventListener?.('devicechange', refresh);
    const onDown = (e: PointerEvent) => {
      if (root.current && !root.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      md?.removeEventListener?.('devicechange', refresh);
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const prefs = devices?.prefs;
  const mics = deviceOptions(list, 'audioinput');
  const speakers = deviceOptions(list, 'audiooutput');
  const run = (p: Promise<void>) => {
    setError('');
    p.then(
      () => force(n => n + 1),
      err => setError(`Could not switch: ${err instanceof Error ? err.message : String(err)}`)
    );
  };

  return (
    <div className="aset" ref={root}>
      <button type="button" className="aset-icon" data-testid="audio-settings" aria-label="Sound settings" aria-expanded={open} title="Sound settings" onClick={() => setOpen(o => !o)}>
        <GearIcon />
      </button>
      {open && (
        <div className={`aset-pop aset-${placement}`} role="dialog" aria-label="Sound settings" data-testid="audio-settings-panel">
          <h3>Sound</h3>
          {!prefs ? (
            <p className="aset-note">Sound starts with the lesson.</p>
          ) : (
            <>
              <label className="aset-field">
                <span>Microphone</span>
                <select data-testid="mic-select" value={mics.some(m => m.id === prefs.micId) ? prefs.micId : ''} onChange={e => run(devices.setMic(e.target.value))}>
                  {mics.map(m => <option key={m.id} value={m.id}>{m.label}</option>)}
                </select>
              </label>
              <div className="aset-meter" data-testid="input-meter" aria-hidden="true">
                <i style={{ width: `${Math.round((live ? levelFraction(levelDb) : 0) * 100)}%` }} />
              </div>
              <label className="aset-field">
                <span>
                  Microphone boost <output>{prefs.inputGain.toFixed(1)}×</output>
                </span>
                <input data-testid="input-gain" type="range" min={INPUT_GAIN_MIN} max={INPUT_GAIN_MAX} step={0.1} value={prefs.inputGain} onChange={e => { devices.setInputGain(Number(e.target.value)); force(n => n + 1); }} />
              </label>
              {devices.canSelectSpeaker && (
                <label className="aset-field">
                  <span>Speaker</span>
                  <select data-testid="speaker-select" value={speakers.some(m => m.id === prefs.speakerId) ? prefs.speakerId : ''} onChange={e => run(devices.setSpeaker(e.target.value))}>
                    {speakers.map(m => <option key={m.id} value={m.id}>{m.label}</option>)}
                  </select>
                </label>
              )}
              <label className="aset-field">
                <span>
                  Tutor volume <output>{Math.round(prefs.outputVolume * 100)}%</output>
                </span>
                <input data-testid="output-volume" type="range" min={0} max={1} step={0.05} value={prefs.outputVolume} onChange={e => { devices.setOutputVolume(Number(e.target.value)); force(n => n + 1); }} />
              </label>
              {error && <p className="aset-note aset-error" role="alert">{error}</p>}
            </>
          )}
        </div>
      )}
    </div>
  );
}

export function GearIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
    </svg>
  );
}
