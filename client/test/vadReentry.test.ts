// Soft onsets after thinking pauses inside an open turn (E2E um-pauses, Chrome mic processing on):
// re-entry threshold, turn-end hold on speech activity (candidates / misfires) with a cap,
// replay of a recorded Silero trace. Levels are passed explicitly (dBFS) to process().
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { VadMachine, type VadEvent } from '../src/audio/vadMachine';
import { loadSettings } from '../src/config';

const FRAME = 512; // 32 ms at 16 kHz
const FRAME_MS = 32;

function cfg(search = '') {
  const s = loadSettings(search);
  return { ...s.voice, ...s.client };
}

type Ev<T extends VadEvent['type']> = Extract<VadEvent, { type: T }>;
type F = { p: number; db: number };

const LOUD_DB = -15;
const SIL_DB = -90;
const sil = (ms: number): F[] => Array.from({ length: Math.round(ms / FRAME_MS) }, () => ({ p: 0.01, db: SIL_DB }));
const talk = (ms: number): F[] => Array.from({ length: Math.round(ms / FRAME_MS) }, () => ({ p: 0.95, db: LOUD_DB }));
const loud = (...ps: number[]): F[] => ps.map(p => ({ p, db: LOUD_DB }));

/** Frame-by-frame driver; `onRequest` answers Smart Turn requests immediately (or not). */
class Driver {
  frame = 0;
  events: { frame: number; e: VadEvent }[] = [];
  constructor(
    readonly m: VadMachine,
    private readonly smartProb: number | null = null
  ) {}
  private take(evs: VadEvent[]) {
    for (const e of evs) {
      this.events.push({ frame: this.frame, e });
      if (e.type === 'smart_turn_request' && this.smartProb !== null) this.take(this.m.smartTurnResult(e.requestId, this.smartProb));
    }
  }
  feed(frames: F[]) {
    for (const f of frames) {
      const amp = Math.pow(10, f.db / 20);
      this.take(this.m.process(f.p, new Float32Array(FRAME).fill(amp), f.db));
      this.frame++;
    }
    return this;
  }
  of<T extends VadEvent['type']>(type: T): { frame: number; e: Ev<T> }[] {
    return this.events.filter(x => x.e.type === type) as { frame: number; e: Ev<T> }[];
  }
  /** ms after the end of frame `from` until the end of the frame of `x`. */
  ms(from: number, x: { frame: number }) {
    return (x.frame + 1 - from) * FRAME_MS;
  }
}

/** The soft "I think…" onset recorded in E2E um-pauses (serial, 2026-10-25T08-05-38): loud
 *  (-8..-22 dBFS, ~60 dB over the floor) but Silero says 0.01-0.44 for ~640 ms. */
const SOFT_ONSET: F[] = [
  { p: 0.0, db: -42 }, { p: 0.01, db: -14 }, { p: 0.06, db: -13 }, { p: 0.23, db: -22 }, { p: 0.12, db: -38 },
  { p: 0.07, db: -41 }, { p: 0.05, db: -42 }, { p: 0.25, db: -15 }, { p: 0.44, db: -8 }, { p: 0.18, db: -12 },
  { p: 0.05, db: -18 }, { p: 0.07, db: -34 }, { p: 0.02, db: -60 }, { p: 0.02, db: -41 }, { p: 0.04, db: -12 },
  { p: 0.09, db: -16 }, { p: 0.38, db: -19 }, { p: 0.1, db: -27 }, { p: 0.03, db: -58 }, { p: 0.36, db: -16 },
  { p: 0.95, db: -13 }, { p: 0.98, db: -16 },
];

describe('VadMachine: soft onsets in an open turn', () => {
  it('soft onset after a 540 ms pause opens a phrase in the same turn (re-entry threshold)', () => {
    const d = new Driver(new VadMachine(cfg()));
    d.feed(sil(1200)).feed(talk(1000)).feed(sil(544));
    const onsetFrame = d.frame;
    d.feed(SOFT_ONSET).feed(talk(1000)).feed(sil(1500));
    expect(d.of('turn_end')).toHaveLength(1);
    const starts = d.of('speech_start');
    expect(starts).toHaveLength(2);
    // opens within ~300 ms of the loud onset (frame 1), not at the 0.95 frame (~640 ms)
    expect(d.ms(onsetFrame, starts[1]!)).toBeLessThanOrEqual(320);
    // pre-roll reaches back to the onset
    expect(starts[1]!.e.prerollMs).toBeGreaterThanOrEqual(d.ms(onsetFrame, starts[1]!) - FRAME_MS);
  });

  it('baseline comparison: without re-entry and hold (?vad_reentry_threshold=0.5&vad_turn_hold_max_ms=0) the turn splits', () => {
    const d = new Driver(new VadMachine(cfg('?vad_reentry_threshold=0.5&vad_turn_hold_max_ms=0')));
    d.feed(sil(1200)).feed(talk(1000)).feed(sil(544)).feed(SOFT_ONSET).feed(talk(1000)).feed(sil(1500));
    expect(d.of('turn_end')).toHaveLength(2);
  });

  it('the re-entry threshold does not apply outside an open turn (first word of a turn)', () => {
    const d = new Driver(new VadMachine(cfg()));
    d.feed(sil(1500)).feed(loud(0.3, 0.3, 0.3, 0.3, 0.3, 0.3)).feed(sil(500));
    expect(d.of('speech_start')).toHaveLength(0);
  });

  it('the re-entry threshold applies only while the turn is open: after turn end 0.3 is not speech', () => {
    const d = new Driver(new VadMachine(cfg()));
    d.feed(sil(1200)).feed(talk(800)).feed(sil(1500));
    expect(d.of('turn_end')).toHaveLength(1);
    d.feed(loud(0.3, 0.3, 0.3, 0.3)).feed(sil(500));
    expect(d.of('speech_start')).toHaveLength(1);
  });

  it('re-entry still needs the energy gate (quiet frames at p 0.3 do not open a phrase)', () => {
    const d = new Driver(new VadMachine(cfg()));
    d.feed(sil(1200)).feed(talk(800)).feed(sil(400));
    d.feed(Array.from({ length: 6 }, () => ({ p: 0.3, db: -85 }))).feed(sil(1200));
    expect(d.of('speech_start')).toHaveLength(1);
    expect(d.of('turn_end')).toHaveLength(1);
  });

  it('while the tutor speaks the barge-in parameters apply, not the re-entry threshold', () => {
    const m = new VadMachine(cfg());
    const d = new Driver(m);
    d.feed(sil(1200)).feed(talk(800)).feed(sil(400));
    m.tutorSpeaking = true;
    d.feed(loud(...Array(20).fill(0.4))).feed(sil(300));
    expect(d.of('speech_start')).toHaveLength(1);
    expect(d.of('barge_in')).toHaveLength(0);
    expect(m.effective()).toMatchObject({ threshold: 0.7, bargeIn: true });
  });

  it('noisy floor: re-entry threshold gets the noisy boost and min speech stays NOISY_MIN_SPEECH_MS', () => {
    const m = new VadMachine(cfg());
    const d = new Driver(m);
    d.feed(Array.from({ length: 50 }, () => ({ p: 0.1, db: -30 })));
    expect(m.noise.state).toBe('noisy');
    d.feed(Array.from({ length: 30 }, () => ({ p: 0.95, db: -5 }))).feed(Array.from({ length: 12 }, () => ({ p: 0.1, db: -30 })));
    expect(d.of('speech_start')).toHaveLength(1);
    expect(m.isTurnOpen).toBe(true);
    const eff = m.effective();
    expect(eff.threshold).toBeCloseTo(cfg().VAD_REENTRY_THRESHOLD + cfg().NOISY_THRESHOLD_BOOST);
    expect(eff.minSpeechMs).toBe(200);
  });
});

describe('VadMachine: speech activity holds the turn open', () => {
  it('misfire right at the Smart Turn end: the turn is not ended in the same frame', () => {
    const d = new Driver(new VadMachine(cfg()), 0.99);
    d.feed(sil(1200)).feed(talk(1500));
    const speechEnd = d.frame;
    // 672 ms silence, then a short candidate that is rejected (gap > VAD_CANDIDATE_GAP_MS) right
    // when SMART_TURN_MIN_SILENCE_MS (750) would end the turn, then speech 700 ms later
    d.feed(sil(672)).feed(loud(0.88, 0.0)).feed(Array.from({ length: 4 }, () => ({ p: 0.0, db: -15 })));
    expect(d.of('misfire')).toHaveLength(1);
    expect(d.of('turn_end')).toHaveLength(0);
    d.feed(sil(320)).feed(talk(800)).feed(sil(1500));
    expect(d.of('turn_end')).toHaveLength(1);
    expect(d.of('speech_start')).toHaveLength(2);
    expect(d.ms(speechEnd, d.of('speech_start')[1]!)).toBeGreaterThan(1000);
  });

  it('a misfire restarts the turn-end wait (silence counted from the misfire)', () => {
    const d = new Driver(new VadMachine(cfg()));
    d.feed(sil(1200)).feed(talk(1000)).feed(sil(500)).feed(loud(0.6)).feed(sil(1500));
    expect(d.of('misfire')).toHaveLength(1);
    const end = d.of('turn_end')[0]!;
    const mis = d.of('misfire')[0]!;
    expect(d.ms(mis.frame, end)).toBeGreaterThanOrEqual(cfg().VAD_TURN_MS - 4 * FRAME_MS);
  });

  it('noise bursts cannot keep a turn open forever: capped at VAD_TURN_MS + VAD_TURN_HOLD_MAX_MS', () => {
    const c = cfg();
    const d = new Driver(new VadMachine(c));
    d.feed(sil(1200)).feed(talk(1000));
    const speechEnd = d.frame;
    // a loud click every 256 ms (single frames: misfires) for 10 s
    d.feed(sil(320)); // phrase end (inside a phrase every burst is speech and extends it)
    for (let i = 0; i < 40; i++) d.feed(loud(0.6)).feed(sil(224));
    const ends = d.of('turn_end');
    expect(ends).toHaveLength(1);
    expect(d.of('speech_start')).toHaveLength(1);
    expect(d.ms(speechEnd, ends[0]!)).toBeLessThanOrEqual(c.VAD_TURN_MS + c.VAD_TURN_HOLD_MAX_MS + FRAME_MS);
    expect(d.ms(speechEnd, ends[0]!)).toBeGreaterThanOrEqual(c.VAD_TURN_MS + c.VAD_TURN_HOLD_MAX_MS - FRAME_MS);
  });

  it('the cap also bounds a Smart Turn "complete" wait', () => {
    const c = cfg();
    const d = new Driver(new VadMachine(c), 0.99);
    d.feed(sil(1200)).feed(talk(1000));
    const speechEnd = d.frame;
    d.feed(sil(320)); // phrase end (inside a phrase every burst is speech and extends it)
    for (let i = 0; i < 40; i++) d.feed(loud(0.6)).feed(sil(224));
    const end = d.of('turn_end')[0]!;
    expect(end.e.reason).toBe('smart_turn');
    expect(d.ms(speechEnd, end)).toBeLessThanOrEqual(c.SMART_TURN_MIN_SILENCE_MS + c.VAD_TURN_HOLD_MAX_MS + FRAME_MS);
  });

  it('complete sentence followed by clean silence: turn end timing unchanged', () => {
    const c = cfg();
    for (const [prob, wait] of [
      [0.99, c.SMART_TURN_MIN_SILENCE_MS],
      [0.1, c.VAD_TURN_MS],
    ] as const) {
      const d = new Driver(new VadMachine(c), prob);
      d.feed(sil(1200)).feed(talk(1500));
      const speechEnd = d.frame;
      d.feed(sil(2000));
      const end = d.of('turn_end')[0]!;
      expect(d.ms(speechEnd, end)).toBeGreaterThanOrEqual(wait);
      expect(d.ms(speechEnd, end)).toBeLessThanOrEqual(wait + FRAME_MS);
    }
  });

  it('trailing low-probability breath after a sentence does not delay the turn end', () => {
    const c = cfg();
    const d = new Driver(new VadMachine(c), 0.99);
    d.feed(sil(1200)).feed(talk(1500));
    const speechEnd = d.frame;
    d.feed(sil(400)).feed(loud(0.15, 0.2, 0.1)).feed(sil(1500));
    const end = d.of('turn_end')[0]!;
    expect(d.ms(speechEnd, end)).toBeLessThanOrEqual(c.SMART_TURN_MIN_SILENCE_MS + FRAME_MS);
  });
});

describe('VadMachine: recorded E2E trace (um-pauses, late onset)', () => {
  const trace = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/vad-um-pauses-late-onset.json'), 'utf8')) as {
    prob: number[];
    db: number[];
  };
  const frames: F[] = trace.prob.map((p, i) => ({ p, db: trace.db[i]! }));

  for (const smart of [null, 0.01, 0.99]) {
    it(`stays one turn (Smart Turn ${smart === null ? 'unavailable' : smart})`, () => {
      const d = new Driver(new VadMachine(cfg()), smart);
      d.feed(frames).feed(sil(2000));
      expect(d.of('turn_end')).toHaveLength(1);
      expect(d.of('speech_start').length).toBeGreaterThanOrEqual(4);
    });
  }

  it('pre-roll of the soft re-entry reaches back to its energy onset', () => {
    const d = new Driver(new VadMachine(cfg()));
    d.feed(frames).feed(sil(2000));
    // 3rd phrase ("I think…"): loud onset after the "so," phrase
    const third = d.of('speech_start')[2]!;
    const lastPhraseEnd = d.of('phrase_end')[1]!.frame;
    const onset = frames.findIndex((f, i) => i > lastPhraseEnd && f.db > -30);
    expect(third.e.prerollMs).toBeGreaterThanOrEqual((third.frame - onset) * FRAME_MS);
  });

  it('baseline settings split it (documents the bug)', () => {
    const d = new Driver(new VadMachine(cfg('?vad_reentry_threshold=0.5&vad_turn_hold_max_ms=0')));
    d.feed(frames).feed(sil(2000));
    expect(d.of('turn_end').length).toBeGreaterThan(1);
  });
});

describe('VadMachine: onset pre-roll', () => {
  const pcmMs = (e: Ev<'chunk'>) => e.pcm.length / 16;

  it('recorded E2E noisy trace: pre-roll covers the loud onset Silero lags by ~0.9 s', () => {
    const trace = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/vad-noisy-late-onset.json'), 'utf8')) as { prob: number[]; db: number[] };
    const frames: F[] = trace.prob.map((p, i) => ({ p, db: trace.db[i]! }));
    const d = new Driver(new VadMachine(cfg()));
    d.feed(frames).feed(sil(1500));
    const start = d.of('speech_start')[0]!;
    // no false phrase starts from the fluctuating noise (incl. after the phrase, re-entry threshold)
    expect(d.of('speech_start')).toHaveLength(1);
    expect(d.of('turn_end')).toHaveLength(1);
    // the onset: first frame >= -20 dBFS (floor ~-42) in the run of loud frames before the start
    const onset = frames.findIndex(f => f.db >= -20);
    const lagMs = (start.frame - onset) * FRAME_MS;
    expect(lagMs).toBeGreaterThan(700);
    expect(start.e.prerollMs).toBeGreaterThanOrEqual(lagMs);
    expect(start.e.prerollMs).toBeLessThanOrEqual(cfg().VAD_PREROLL_MAX_MS + FRAME_MS);
    // with the old fixed pre-roll the onset was cut
    const old = new Driver(new VadMachine(cfg('?vad_preroll_max_ms=0')));
    old.feed(frames);
    expect(old.of('speech_start')[0]!.e.prerollMs).toBeLessThan(lagMs - 400);
  });

  it('a clean start after silence keeps VAD_PREROLL_MS (320 ms of whole frames)', () => {
    const d = new Driver(new VadMachine(cfg()));
    d.feed(sil(1500)).feed(talk(500));
    expect(d.of('speech_start')[0]!.e.prerollMs).toBe(320);
  });

  it('pre-roll is VAD_PREROLL_MS before the energy onset, capped at VAD_PREROLL_MAX_MS', () => {
    const c = cfg();
    const d = new Driver(new VadMachine(c));
    // 480 ms of loud low-probability sound, then speech
    d.feed(sil(1500)).feed(loud(...Array(15).fill(0.1))).feed(talk(500));
    const p = d.of('speech_start')[0]!.e.prerollMs;
    expect(p).toBeGreaterThanOrEqual(480 + c.VAD_PREROLL_MS);
    expect(p).toBeLessThanOrEqual(480 + c.VAD_PREROLL_MS + FRAME_MS);
    const d2 = new Driver(new VadMachine(c));
    d2.feed(sil(1500)).feed(loud(...Array(60).fill(0.1))).feed(talk(500));
    expect(d2.of('speech_start')[0]!.e.prerollMs).toBeLessThanOrEqual(c.VAD_PREROLL_MAX_MS + FRAME_MS);
    expect(d2.of('speech_start')[0]!.e.prerollMs).toBeGreaterThanOrEqual(c.VAD_PREROLL_MAX_MS);
    const first = d2.of('chunk')[0]!.e;
    expect(pcmMs(first)).toBeLessThan(2000); // module limit
  });

  it('barge-in keeps the fixed VAD_PREROLL_MS (no tutor echo in the student phrase)', () => {
    const m = new VadMachine(cfg());
    const d = new Driver(m);
    d.feed(sil(1500));
    m.tutorSpeaking = true;
    d.feed(loud(...Array(20).fill(0.3))).feed(talk(600));
    const s = d.of('speech_start')[0]!.e;
    expect(s.bargeIn).toBe(true);
    expect(s.prerollMs).toBe(320);
  });
});
