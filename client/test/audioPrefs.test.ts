import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PREFS,
  PREFS_KEY,
  clampInputGain,
  clampVolume,
  deviceAvailable,
  deviceOptions,
  levelFraction,
  loadPrefs,
  micConstraints,
  micErrorMessage,
  savePrefs,
  sinkSelectable,
} from '../src/audio/audioPrefs';

function memStore(init: Record<string, string> = {}) {
  const m = new Map(Object.entries(init));
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), m };
}

describe('audio prefs', () => {
  it('defaults when empty, corrupt or storage throws', () => {
    expect(loadPrefs(memStore())).toEqual(DEFAULT_PREFS);
    expect(loadPrefs(memStore({ [PREFS_KEY]: '{not json' }))).toEqual(DEFAULT_PREFS);
    const throwing = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } };
    expect(loadPrefs(throwing)).toEqual(DEFAULT_PREFS);
    expect(savePrefs({ inputGain: 2 }, throwing).inputGain).toBe(2);
    expect(loadPrefs(null)).toEqual(DEFAULT_PREFS);
  });

  it('round-trips and clamps', () => {
    const s = memStore();
    savePrefs({ micId: 'mic-1', inputGain: 9, outputVolume: 0.4 }, s);
    expect(loadPrefs(s)).toEqual({ micId: 'mic-1', speakerId: '', inputGain: 4, outputVolume: 0.4 });
    savePrefs({ speakerId: 'spk' }, s);
    expect(loadPrefs(s).micId).toBe('mic-1');
    expect(loadPrefs(memStore({ [PREFS_KEY]: JSON.stringify({ inputGain: 'x', outputVolume: -1, micId: 5 }) }))).toEqual({ ...DEFAULT_PREFS, outputVolume: 0 });
  });

  it('gain range 0.5–4×, volume 0–1', () => {
    expect(clampInputGain(0.1)).toBe(0.5);
    expect(clampInputGain(1.5)).toBe(1.5);
    expect(clampInputGain(NaN)).toBe(1);
    expect(clampVolume(2)).toBe(1);
    expect(clampVolume(0)).toBe(0);
  });

  it('mic constraints keep the processing flags and add the exact device', () => {
    const base = { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: false };
    expect(micConstraints(base, '')).toEqual(base);
    expect(micConstraints(base, 'abc')).toEqual({ ...base, deviceId: { exact: 'abc' } });
  });

  it('device lists and fallback after unplugging', () => {
    const devs = [
      { kind: 'audioinput', deviceId: 'default', label: 'Default' },
      { kind: 'audioinput', deviceId: 'a', label: 'USB mic' },
      { kind: 'audioinput', deviceId: 'b', label: '' },
      { kind: 'audiooutput', deviceId: 'o', label: 'Headphones' },
      { kind: 'videoinput', deviceId: 'v', label: 'Cam' },
    ];
    expect(deviceOptions(devs, 'audioinput')).toEqual([
      { id: '', label: 'System default' },
      { id: 'a', label: 'USB mic' },
      { id: 'b', label: 'Microphone 2' },
    ]);
    expect(deviceOptions(devs, 'audiooutput').map(d => d.id)).toEqual(['', 'o']);
    expect(deviceAvailable(devs, 'audioinput', 'a')).toBe(true);
    expect(deviceAvailable(devs, 'audioinput', 'gone')).toBe(false);
    expect(deviceAvailable(devs, 'audioinput', '')).toBe(true);
    expect(deviceAvailable(devs, 'audiooutput', 'a')).toBe(false);
  });

  it('speaker selection only with setSinkId', () => {
    expect(sinkSelectable({ setSinkId: async () => {} })).toBe(true);
    expect(sinkSelectable({})).toBe(false);
    expect(sinkSelectable(null)).toBe(false);
  });

  it('level meter and mic error copy', () => {
    expect(levelFraction(-100)).toBe(0);
    expect(levelFraction(-35)).toBeCloseTo(0.5);
    expect(levelFraction(0)).toBe(1);
    expect(micErrorMessage(Object.assign(new Error('x'), { name: 'NotAllowedError' }))).toMatch(/blocked/);
    expect(micErrorMessage(Object.assign(new Error('x'), { name: 'NotFoundError' }))).toMatch(/No microphone/);
    expect(micErrorMessage(new Error('boom'))).toMatch(/boom/);
  });
});
