import { describe, expect, it } from 'vitest';
import { VadMachine, type VadEvent } from '../src/audio/vadMachine';
import { loadSettings } from '../src/config';

const FRAME = 512; // 32 ms at 16 kHz (Silero v5)
const FRAME_MS = 32;

function cfg(search = '') {
  const s = loadSettings(search);
  return { ...s.voice, ...s.client };
}

/** A frame at a given amplitude (constant signal -> RMS = amp). */
function frame(amp: number): Float32Array {
  return new Float32Array(FRAME).fill(amp);
}

const LOUD = 0.1; // -20 dBFS
const QUIET = 0.001; // -60 dBFS

type Step = { ms: number; prob: number; amp?: number };

function run(m: VadMachine, steps: Step[], onFrame?: (i: number) => void): { events: VadEvent[]; at: number[] } {
  const events: VadEvent[] = [];
  const at: number[] = [];
  let t = 0;
  let i = 0;
  for (const s of steps) {
    const n = Math.round(s.ms / FRAME_MS);
    for (let k = 0; k < n; k++) {
      onFrame?.(i++);
      const amp = s.amp ?? (s.prob >= 0.5 ? LOUD : QUIET);
      for (const e of m.process(s.prob, frame(amp))) {
        events.push(e);
        at.push(t);
      }
      t += FRAME_MS;
    }
  }
  return { events, at };
}

const types = (ev: VadEvent[]) => ev.filter(e => e.type !== 'noise_state').map(e => e.type);
const silence = (ms: number): Step => ({ ms, prob: 0.02 });
const speech = (ms: number): Step => ({ ms, prob: 0.95 });

describe('VadMachine', () => {
  it('one phrase, then turn end after VAD_TURN_MS silence', () => {
    const m = new VadMachine(cfg());
    const { events, at } = run(m, [silence(1000), speech(800), silence(1200)]);
    const t = types(events);
    expect(t[0]).toBe('speech_start');
    expect(t.filter(x => x === 'phrase_end')).toHaveLength(1);
    expect(t.filter(x => x === 'turn_end')).toHaveLength(1);
    expect(t.indexOf('phrase_end')).toBeLessThan(t.indexOf('turn_end'));

    const chunks = events.filter(e => e.type === 'chunk') as Extract<VadEvent, { type: 'chunk' }>[];
    expect(chunks.map(c => c.seq)).toEqual(chunks.map((_, i) => i));
    expect(chunks.at(-1)!.final).toBe(true);
    expect(chunks.slice(0, -1).every(c => !c.final)).toBe(true);
    // first chunk carries the pre-roll (300 ms) + the confirming speech (>= 50 ms)
    expect(chunks[0]!.pcm.length).toBeGreaterThanOrEqual(16 * 350);
    // middle chunks are ~150 ms (whole frames)
    for (const c of chunks.slice(1, -1)) expect(c.pcm.length).toBeGreaterThanOrEqual(16 * 150);

    // phrase end ~VAD_PHRASE_MS after speech stops, turn end ~VAD_TURN_MS after
    const speechEnd = (Math.round(1000 / FRAME_MS) + Math.round(800 / FRAME_MS)) * FRAME_MS;
    // `at` is the start time of the frame that produced the event; elapsed = at + one frame
    const pe = at[events.findIndex(e => e.type === 'phrase_end')]! + FRAME_MS;
    const te = at[events.findIndex(e => e.type === 'turn_end')]! + FRAME_MS;
    expect(pe - speechEnd).toBeGreaterThanOrEqual(300);
    expect(pe - speechEnd).toBeLessThanOrEqual(300 + FRAME_MS);
    const turnMs = cfg().VAD_TURN_MS;
    expect(turnMs).toBe(900);
    expect(te - speechEnd).toBeGreaterThanOrEqual(turnMs);
    expect(te - speechEnd).toBeLessThanOrEqual(turnMs + FRAME_MS);
  });

  it('a pause between phrase and turn length keeps the same turn', () => {
    const m = new VadMachine(cfg());
    const { events } = run(m, [silence(1000), speech(600), silence(450), speech(600), silence(1000)]);
    const t = types(events);
    expect(t.filter(x => x === 'speech_start')).toHaveLength(2);
    expect(t.filter(x => x === 'phrase_end')).toHaveLength(2);
    expect(t.filter(x => x === 'turn_end')).toHaveLength(1);
    const starts = events.filter(e => e.type === 'speech_start') as Extract<VadEvent, { type: 'speech_start' }>[];
    expect(starts[1]!.phraseId).toBe(starts[0]!.phraseId + 1);
  });

  it('honours VAD_TURN_MS override from the URL', () => {
    const m = new VadMachine(cfg('?vad_turn_ms=1500'));
    const { events } = run(m, [silence(1000), speech(600), silence(1000), speech(600), silence(2000)]);
    expect(types(events).filter(x => x === 'turn_end')).toHaveLength(1);
  });

  it('short blips below VAD_MIN_SPEECH_MS are misfires, no audio sent', () => {
    const m = new VadMachine(cfg());
    // VAD_MIN_SPEECH_MS 50: a single 32 ms frame is a click, two frames (64 ms) start speech.
    const { events } = run(m, [silence(1000), speech(32), silence(500), speech(32), silence(500)]);
    const t = types(events);
    expect(t).not.toContain('chunk');
    expect(t.filter(x => x === 'misfire')).toHaveLength(2);
    const m2 = new VadMachine(cfg());
    expect(types(run(m2, [silence(1000), speech(64), silence(1500)]).events)).toContain('speech_start');
  });

  it('a thinking pause of 600 ms stays in the turn with VAD_TURN_MS 900', () => {
    const m = new VadMachine(cfg());
    const { events } = run(m, [silence(1000), speech(600), silence(608), speech(600), silence(1500)]);
    expect(types(events).filter(x => x === 'turn_end')).toHaveLength(1);
  });

  it('splits phrases longer than VAD_MAX_PHRASE_MS', () => {
    const m = new VadMachine(cfg('?vad_max_phrase_ms=2000'));
    const { events } = run(m, [silence(1000), speech(5000), silence(1000)]);
    const t = types(events);
    expect(t.filter(x => x === 'speech_start').length).toBeGreaterThanOrEqual(3);
    const finals = events.filter(e => e.type === 'chunk' && e.final);
    expect(finals.length).toBe(t.filter(x => x === 'speech_start').length);
    expect(t.filter(x => x === 'turn_end')).toHaveLength(1);
  });

  it('barge-in needs BARGE_IN_THRESHOLD and BARGE_IN_MIN_MS while the tutor speaks', () => {
    const m = new VadMachine(cfg());
    m.tutorSpeaking = true;
    // 0.6 is speech normally, but below the 0.7 barge-in threshold
    let r = run(m, [silence(1000), { ms: 800, prob: 0.6, amp: LOUD }, silence(800)]);
    expect(types(r.events)).not.toContain('barge_in');
    expect(types(r.events)).not.toContain('speech_start');
    // 300 ms of strong speech: not long enough
    r = run(m, [speech(300), silence(800)]);
    expect(types(r.events)).not.toContain('barge_in');
    // 500 ms: barge-in, then a normal phrase
    r = run(m, [speech(600), silence(1000)]);
    const t = types(r.events);
    expect(t[0]).toBe('barge_in');
    expect(t[1]).toBe('speech_start');
    expect(t).toContain('phrase_end');
    expect(t).toContain('turn_end');
    const start = r.events.find(e => e.type === 'speech_start') as Extract<VadEvent, { type: 'speech_start' }>;
    expect(start.bargeIn).toBe(true);
  });

  it('energy gate: steady loud background with high probability cannot open a phrase', () => {
    const m = new VadMachine(cfg());
    // floor seeded at -20 dBFS (non-speech frames), then "speech" at the same level
    const { events } = run(m, [{ ms: 1200, prob: 0.1, amp: LOUD }, { ms: 600, prob: 0.9, amp: LOUD }]);
    expect(types(events)).not.toContain('speech_start');
    // 10+ dB above the floor passes
    const r = run(m, [silence(200), { ms: 600, prob: 0.9, amp: 0.5 }]);
    expect(types(r.events)).toContain('speech_start');
  });

  it('noisy floor raises threshold and min speech', () => {
    const m = new VadMachine(cfg());
    run(m, [{ ms: 1500, prob: 0.1, amp: 0.03 }]); // ~ -30 dBFS floor -> noisy
    expect(m.noise.state).toBe('noisy');
    const eff = m.effective();
    expect(eff.threshold).toBeCloseTo(0.6);
    expect(eff.minSpeechMs).toBe(200);
    // prob 0.55 at a loud level: speech when quiet, not when noisy
    const r = run(m, [{ ms: 600, prob: 0.55, amp: 0.5 }]);
    expect(types(r.events)).not.toContain('speech_start');
  });

  it('stop() closes an open phrase with a final chunk and ends the turn', () => {
    const m = new VadMachine(cfg());
    run(m, [silence(500), speech(500)]);
    expect(m.inPhrase).toBe(true);
    const ev = m.stop();
    expect(ev.map(e => e.type)).toEqual(['chunk', 'phrase_end', 'turn_end']);
    expect((ev[0] as Extract<VadEvent, { type: 'chunk' }>).final).toBe(true);
  });

  it('starts phrase ids after the given first id (resume)', () => {
    const m = new VadMachine(cfg(), { firstPhraseId: 7 });
    const { events } = run(m, [silence(500), speech(500), silence(500)]);
    const start = events.find(e => e.type === 'speech_start') as Extract<VadEvent, { type: 'speech_start' }>;
    expect(start.phraseId).toBe(7);
  });
});
