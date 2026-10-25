// VadMachine + Smart Turn decisions with synthetic model probabilities.
import { describe, expect, it } from 'vitest';
import { VadMachine, type VadEvent } from '../src/audio/vadMachine';
import { loadSettings } from '../src/config';

const FRAME = 512; // 32 ms at 16 kHz
const FRAME_MS = 32;
const LOUD = 0.1;
const QUIET = 0.001;

function cfg(search = '') {
  const s = loadSettings(search);
  return { ...s.voice, ...s.client };
}

type Ev<T extends VadEvent['type']> = Extract<VadEvent, { type: T }>;

/** Drives the machine frame by frame; `onRequest` answers smart_turn_request (now, or later). */
class Driver {
  t = 0;
  events: { at: number; e: VadEvent }[] = [];
  constructor(
    readonly m: VadMachine,
    private readonly onRequest?: (r: Ev<'smart_turn_request'>, d: Driver) => void
  ) {}
  private take(evs: VadEvent[]) {
    for (const e of evs) {
      this.events.push({ at: this.t, e });
      if (e.type === 'smart_turn_request') this.onRequest?.(e, this);
    }
  }
  frames(ms: number, prob: number) {
    for (let k = 0; k < Math.round(ms / FRAME_MS); k++) {
      this.t += FRAME_MS; // time after this frame
      this.take(this.m.process(prob, new Float32Array(FRAME).fill(prob >= 0.5 ? LOUD : QUIET)));
    }
    return this;
  }
  speech(ms: number) {
    return this.frames(ms, 0.95);
  }
  silence(ms: number) {
    return this.frames(ms, 0.02);
  }
  answer(requestId: number, prob: number) {
    this.take(this.m.smartTurnResult(requestId, prob));
  }
  of<T extends VadEvent['type']>(type: T): { at: number; e: Ev<T> }[] {
    return this.events.filter(x => x.e.type === type) as { at: number; e: Ev<T> }[];
  }
}

describe('VadMachine + Smart Turn', () => {
  it('asks at phrase end with the turn audio (pre-roll, speech, trailing silence)', () => {
    const d = new Driver(new VadMachine(cfg()));
    d.silence(1000).speech(800).silence(400);
    const reqs = d.of('smart_turn_request');
    expect(reqs).toHaveLength(1);
    const phraseEnd = d.of('phrase_end')[0]!;
    expect(reqs[0]!.at).toBe(phraseEnd.at);
    const ms = reqs[0]!.e.pcm.length / 16;
    // ~300 ms pre-roll + 800 ms speech + ~320 ms silence up to the phrase end
    expect(ms).toBeGreaterThanOrEqual(800 + 300 + 300);
    expect(ms).toBeLessThanOrEqual(800 + 300 + 300 + 3 * FRAME_MS);
    expect(reqs[0]!.e.silenceMs).toBeGreaterThanOrEqual(300);
  });

  it('"complete" ends the turn right at the phrase end instead of after VAD_TURN_MS', () => {
    const d = new Driver(new VadMachine(cfg('?vad_turn_ms=900')), (r, dd) => dd.answer(r.requestId, 0.9));
    d.silence(1000).speech(800).silence(1500);
    const ends = d.of('turn_end');
    expect(ends).toHaveLength(1);
    expect(ends[0]!.e.reason).toBe('smart_turn');
    expect(ends[0]!.at).toBe(d.of('phrase_end')[0]!.at);
    expect(ends[0]!.e.silenceMs).toBeLessThan(400);
    const st = d.of('smart_turn')[0]!.e;
    expect(st).toMatchObject({ decision: 'complete', ended: true, prob: 0.9 });
  });

  it('"incomplete" keeps waiting for the VAD_TURN_MS fallback', () => {
    const d = new Driver(new VadMachine(cfg('?vad_turn_ms=900')), (r, dd) => dd.answer(r.requestId, 0.2));
    d.silence(1000).speech(800).silence(1500);
    const ends = d.of('turn_end');
    expect(ends).toHaveLength(1);
    expect(ends[0]!.e.reason).toBe('silence');
    expect(ends[0]!.e.silenceMs).toBeGreaterThanOrEqual(900);
    expect(d.of('smart_turn')[0]!.e.decision).toBe('incomplete');
  });

  it('a late "complete" verdict ends the turn when it arrives', () => {
    let pending = 0;
    const d = new Driver(new VadMachine(cfg('?vad_turn_ms=900')), r => (pending = r.requestId));
    d.silence(1000).speech(800).silence(320 + 5 * FRAME_MS); // inference "takes" ~160 ms
    expect(d.of('turn_end')).toHaveLength(0);
    d.answer(pending, 0.8);
    const ends = d.of('turn_end');
    expect(ends).toHaveLength(1);
    expect(ends[0]!.e.reason).toBe('smart_turn');
    expect(ends[0]!.e.silenceMs).toBeGreaterThanOrEqual(480);
  });

  it('SMART_TURN_MIN_SILENCE_MS above the phrase end delays a "complete" turn end', () => {
    const d = new Driver(new VadMachine(cfg('?vad_turn_ms=900&smart_turn_min_silence_ms=600')), (r, dd) =>
      dd.answer(r.requestId, 0.95)
    );
    d.silence(1000).speech(800).silence(1500);
    const st = d.of('smart_turn')[0]!.e;
    expect(st).toMatchObject({ decision: 'complete', ended: false });
    const end = d.of('turn_end')[0]!.e;
    expect(end.reason).toBe('smart_turn');
    expect(end.silenceMs).toBeGreaterThanOrEqual(600);
    expect(end.silenceMs).toBeLessThan(600 + FRAME_MS);
  });

  it('speech resuming before the verdict cancels it: one turn', () => {
    const reqs: number[] = [];
    const d = new Driver(new VadMachine(cfg('?vad_turn_ms=900')), r => reqs.push(r.requestId));
    d.silence(1000).speech(600).silence(450); // phrase end, verdict outstanding
    d.speech(600); // thinking pause over
    d.answer(reqs[0]!, 0.99); // arrives too late
    expect(d.of('smart_turn')[0]!.e.decision).toBe('stale');
    expect(d.of('turn_end')).toHaveLength(0);
    d.silence(400);
    expect(reqs).toHaveLength(2);
    d.answer(reqs[1]!, 0.1);
    d.silence(1000);
    expect(d.of('turn_end')).toHaveLength(1);
    expect(d.of('turn_end')[0]!.e.reason).toBe('silence');
  });

  it('a "complete" verdict is cleared when speech resumes before the min silence', () => {
    const d = new Driver(new VadMachine(cfg('?vad_turn_ms=900&smart_turn_min_silence_ms=700')), (r, dd) =>
      dd.answer(r.requestId, r.requestId === 1 ? 0.9 : 0.1)
    );
    d.silence(1000).speech(600).silence(500).speech(600).silence(1500);
    const ends = d.of('turn_end');
    expect(ends).toHaveLength(1);
    expect(ends[0]!.e.reason).toBe('silence');
    expect(d.of('speech_start')).toHaveLength(2);
  });

  it('the second request covers the whole turn including the pause', () => {
    const lens: number[] = [];
    const d = new Driver(new VadMachine(cfg()), r => lens.push(r.pcm.length / 16));
    d.silence(1000).speech(600).silence(450).speech(600).silence(400);
    expect(lens).toHaveLength(2);
    expect(lens[1]! - lens[0]!).toBeGreaterThanOrEqual(450 - 320 + 600 + 300 - FRAME_MS);
  });

  it('turn audio is capped at the last 8 s', () => {
    const lens: number[] = [];
    const d = new Driver(new VadMachine(cfg('?vad_max_phrase_ms=20000')), r => lens.push(r.pcm.length / 16));
    d.silence(1000).speech(12000).silence(400);
    expect(lens).toHaveLength(1);
    expect(lens[0]).toBeGreaterThanOrEqual(8000 - FRAME_MS);
    expect(lens[0]).toBeLessThanOrEqual(8000);
  });

  it('a verdict after the fallback turn end is stale', () => {
    let pending = 0;
    const d = new Driver(new VadMachine(cfg('?vad_turn_ms=900')), r => (pending = r.requestId));
    d.silence(1000).speech(800).silence(1200);
    expect(d.of('turn_end')[0]!.e.reason).toBe('silence');
    d.answer(pending, 0.99);
    expect(d.of('smart_turn')[0]!.e.decision).toBe('stale');
    expect(d.of('turn_end')).toHaveLength(1);
  });

  it('SMART_TURN_THRESHOLD is the cut-off', () => {
    const d = new Driver(new VadMachine(cfg('?smart_turn_threshold=0.7')), (r, dd) => dd.answer(r.requestId, 0.6));
    d.silence(1000).speech(800).silence(1500);
    expect(d.of('smart_turn')[0]!.e.decision).toBe('incomplete');
    expect(d.of('turn_end')[0]!.e.reason).toBe('silence');
  });

  it('?smart_turn=0: no requests, silence-only turn end', () => {
    const d = new Driver(new VadMachine(cfg('?smart_turn=0')));
    d.silence(1000).speech(800).silence(1500);
    expect(d.of('smart_turn_request')).toHaveLength(0);
    expect(d.of('turn_end')[0]!.e.reason).toBe('silence');
  });

  it('barge-in is unchanged and stop() ends the turn with reason stop', () => {
    const m = new VadMachine(cfg());
    m.tutorSpeaking = true;
    const d = new Driver(m);
    d.silence(1000).speech(600);
    expect(d.events.map(x => x.e.type)).toContain('barge_in');
    const ev = m.stop();
    expect(ev.find(e => e.type === 'turn_end')).toMatchObject({ reason: 'stop' });
  });
});
