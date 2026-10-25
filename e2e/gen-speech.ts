// Generates test-student speech for the E2E tests with Cartesia TTS (young "Daisy" voice,
// different from the tutor's), inserts silences to trigger phrase/turn ends, optionally mixes
// in background noise, and writes 16-bit mono WAVs for Chrome's fake microphone
// (--use-file-for-fake-audio-capture; needs --no-sandbox on macOS, and Chrome loops the file).
// Output: e2e/fixtures/*.wav (+ .json with source text). Fixtures are generated, not committed.
//
// Usage: pnpm --filter e2e gen-speech
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MODULE_DEFAULTS, TEST_STUDENT_VOICE_ID } from '@tutor/shared';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const OUT = path.join(HERE, 'fixtures');
const RATE = 48000; // Chrome's fake capture resamples; 48 kHz avoids artifacts
/** Chrome loops the fake-capture file; trailing silence keeps a test from hearing speech twice. */
const TRAILING_SILENCE_MS = 60_000;

/** |sample| below this counts as silence when trimming TTS clips (about -40 dBFS). */
const TRIM_LEVEL = 300;
/** Keep this much of each clip's own lead-in/tail so onsets and decays are not cut. */
const TRIM_KEEP_MS = 20;

/** Nearest directory (repo root or an ancestor, e.g. for git worktrees) that holds .env. */
function findEnvDir(start = ROOT): string {
  for (let dir = start; ; dir = path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, '.env'))) return dir;
    if (path.dirname(dir) === dir) return start;
  }
}

function loadEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  if (process.env.CARTESIA_API_KEY) out.CARTESIA_API_KEY = process.env.CARTESIA_API_KEY;
  const dir = findEnvDir();
  for (const f of ['.env', '.env.local']) {
    const p = path.join(dir, f);
    if (!fs.existsSync(p)) continue;
    for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z_]\w*)\s*=\s*(.*?)\s*$/);
      if (m) out[m[1]!] = m[2]!.replace(/^(['"])(.*)\1$/, '$2');
    }
  }
  if (process.env.CARTESIA_API_KEY) out.CARTESIA_API_KEY = process.env.CARTESIA_API_KEY;
  return out;
}

/** Cartesia clips carry their own leading/trailing silence, which lengthens the scripted pauses
 *  (a 500 ms thinking pause became > 700 ms and ended the turn). Trim it so gaps are exact. */
function trimSilence(s: Int16Array): Int16Array {
  let a = 0;
  let b = s.length - 1;
  while (a < s.length && Math.abs(s[a]!) < TRIM_LEVEL) a++;
  while (b > a && Math.abs(s[b]!) < TRIM_LEVEL) b--;
  if (a >= b) return s;
  const keep = Math.round((TRIM_KEEP_MS / 1000) * RATE);
  return s.subarray(Math.max(0, a - keep), Math.min(s.length, b + 1 + keep));
}

/** A segment is speech (text) or silence (ms). */
type Segment = { say: string } | { silenceMs: number };
interface Scenario {
  name: string;
  segments: Segment[];
  /** Background noise level in dBFS (white-ish noise), or undefined for none. */
  noiseDbfs?: number;
  description: string;
}

// Turn ends need > VAD_TURN_MS (700) of silence; phrase ends > VAD_PHRASE_MS (300).
export const SCENARIOS: Scenario[] = [
  {
    name: 'correct-step',
    description: 'Student states a correct step in one turn.',
    segments: [{ silenceMs: 1500 }, { say: 'I multiply the top and the bottom by four.' }, { silenceMs: 2500 }],
  },
  {
    name: 'wrong-step',
    description: 'Student makes the classic expand-only-the-top mistake.',
    segments: [
      { silenceMs: 1500 },
      { say: 'Two thirds is the same as eight thirds.' },
      { silenceMs: 450 },
      { say: 'Because I multiplied the top by four.' },
      { silenceMs: 2500 },
    ],
  },
  {
    name: 'um-pauses',
    description: 'Hesitations with thinking pauses shorter than the turn end, same turn.',
    segments: [
      { silenceMs: 1500 },
      { say: 'Um, so,' },
      { silenceMs: 500 },
      { say: 'I think the bottom number says how many pieces.' },
      { silenceMs: 550 },
      { say: 'Uh, and the top is how many I have.' },
      { silenceMs: 2500 },
    ],
  },
  {
    name: 'noisy',
    description: 'Correct step with steady background noise.',
    noiseDbfs: -42,
    segments: [{ silenceMs: 2000 }, { say: 'I need to find the number to multiply by.' }, { silenceMs: 2500 }],
  },
  {
    name: 'interrupt',
    description: 'Opening question, long wait while the tutor answers, then barge-in during the reply.',
    segments: [
      { silenceMs: 1500 },
      { say: 'I do not understand how to expand fractions.' },
      // the tutor starts speaking ~2-3 s after turn end; interrupt mid-reply
      { silenceMs: 5500 },
      { say: 'Wait, I have a question. Why does the bottom change too?' },
      { silenceMs: 6000 },
    ],
  },
];

async function tts(text: string, env: Record<string, string>): Promise<Int16Array> {
  const res = await fetch('https://api.cartesia.ai/tts/bytes', {
    method: 'POST',
    headers: {
      'Cartesia-Version': MODULE_DEFAULTS.CARTESIA_VERSION,
      Authorization: `Bearer ${env.CARTESIA_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model_id: MODULE_DEFAULTS.CARTESIA_TTS_MODEL,
      transcript: text,
      voice: { mode: 'id', id: TEST_STUDENT_VOICE_ID },
      language: 'en',
      output_format: { container: 'raw', encoding: 'pcm_s16le', sample_rate: RATE },
    }),
  });
  if (!res.ok) throw new Error(`TTS ${res.status}: ${await res.text()}`);
  const buf = Buffer.from(await res.arrayBuffer());
  return new Int16Array(buf.buffer, buf.byteOffset, buf.byteLength / 2);
}

function wav(samples: Int16Array, rate: number): Buffer {
  const data = Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0);
  h.writeUInt32LE(36 + data.length, 4);
  h.write('WAVE', 8);
  h.write('fmt ', 12);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36);
  h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

/** Deterministic pseudo-random noise so fixtures are reproducible. */
function mixNoise(s: Int16Array, dbfs: number): void {
  const amp = 32767 * 10 ** (dbfs / 20) * Math.SQRT2;
  let x = 12345;
  let lp = 0;
  for (let i = 0; i < s.length; i++) {
    x = (x * 1103515245 + 12345) & 0x7fffffff;
    const white = (x / 0x7fffffff) * 2 - 1;
    lp = lp * 0.7 + white * 0.3; // slightly darker than white, like room/fan noise
    s[i] = Math.max(-32768, Math.min(32767, s[i]! + lp * amp * 1.8));
  }
}

async function main(): Promise<void> {
  const env = loadEnv();
  if (!env.CARTESIA_API_KEY) throw new Error('CARTESIA_API_KEY missing in .env');
  fs.mkdirSync(OUT, { recursive: true });
  for (const sc of SCENARIOS) {
    const parts: Int16Array[] = [];
    const timeline: { say: string; startMs: number; endMs: number }[] = [];
    let ms = 0;
    for (const seg of sc.segments) {
      const pcm = 'say' in seg ? trimSilence(await tts(seg.say, env)) : new Int16Array(Math.round((seg.silenceMs / 1000) * RATE));
      const dur = (pcm.length / RATE) * 1000;
      if ('say' in seg) timeline.push({ say: seg.say, startMs: Math.round(ms), endMs: Math.round(ms + dur) });
      parts.push(pcm);
      ms += dur;
    }
    const all = new Int16Array(parts.reduce((n, p) => n + p.length, 0));
    let o = 0;
    for (const p of parts) {
      all.set(p, o);
      o += p.length;
    }
    const padded = new Int16Array(all.length + Math.round((TRAILING_SILENCE_MS / 1000) * RATE));
    padded.set(all);
    if (sc.noiseDbfs !== undefined) mixNoise(padded, sc.noiseDbfs);
    fs.writeFileSync(path.join(OUT, `${sc.name}.wav`), wav(padded, RATE));
    // Actual pause between consecutive utterances: the scripted silence plus what is left of the
    // clips' own lead-in/tail (at most 2 x TRIM_KEEP_MS below TRIM_LEVEL).
    const gapsMs = timeline.slice(1).map((t, i) => t.startMs - timeline[i]!.endMs + 2 * TRIM_KEEP_MS);
    fs.writeFileSync(
      path.join(OUT, `${sc.name}.json`),
      JSON.stringify(
        {
          name: sc.name,
          description: sc.description,
          noiseDbfs: sc.noiseDbfs ?? null,
          durationMs: Math.round(ms),
          text: timeline.map(t => t.say).join(' '),
          timeline,
          gapsMs,
          trim: { level: TRIM_LEVEL, keepMs: TRIM_KEEP_MS },
        },
        null,
        2
      )
    );
    console.log(`${sc.name}.wav  ${(ms / 1000).toFixed(1)} s  ${timeline.length} utterances  gaps ${JSON.stringify(gapsMs)} ms`);
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
