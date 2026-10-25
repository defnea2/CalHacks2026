// Real provider smoke test without browser automation or microphone capture.
// Requires the local voice stack. Creates a synthetic learner/session, sends generated
// PCM through the real STT reducer, and checks tutor audio plus canvas command validity.
// This does not measure browser playback, VAD, or audible synchronization.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { MODULE_DEFAULTS, TEST_STUDENT_VOICE_ID } from '@tutor/shared';
import { DbConnection } from '../worker/src/module_bindings';
import type { AudioOut } from '../worker/src/module_bindings/types';
import { findEnvDir, loadConfig, parseEnv } from '../worker/src/env';
import { SpeechCanvasPlayer } from '../src/presentation/voice/SpeechCanvasPlayer';

const cfg = loadConfig();
assert.equal(new URL(cfg.spacetimeUri).hostname, '127.0.0.1', 'Smoke tests require the local database');
const envDir = findEnvDir();
const env = { ...Object.fromEntries(['.env', '.env.local'].flatMap(name => {
  const file = path.join(envDir, name);
  return fs.existsSync(file) ? Object.entries(parseEnv(fs.readFileSync(file, 'utf8'))) : [];
})), ...process.env };
assert.ok(env.CARTESIA_API_KEY, 'CARTESIA_API_KEY missing');
const prompts = process.argv.length > 2 ? process.argv.slice(2) : [
  'I know a rectangle has area base times height. Why does a slanted parallelogram have the same area? Please show me by cutting and moving the triangle.',
  'I predict the area stays the same because no pieces disappear. The rectangle has area six times four, which is twenty four. Now please cut the triangle and slide it to make a rectangle.',
];

async function waitFor<T>(label: string, read: () => T | undefined, timeout = 60_000): Promise<T> {
  const until = Date.now() + timeout;
  do {
    const result = read();
    if (result !== undefined) return result;
    await new Promise(resolve => setTimeout(resolve, 100));
  } while (Date.now() < until);
  throw new Error(`Timed out waiting for ${label}`);
}

async function synthesizeStudent(prompt: string) {
  const speech = await fetch('https://api.cartesia.ai/tts/bytes', {
    method: 'POST', signal: AbortSignal.timeout(30_000),
    headers: { Authorization: `Bearer ${env.CARTESIA_API_KEY}`, 'Cartesia-Version': env.CARTESIA_VERSION || MODULE_DEFAULTS.CARTESIA_VERSION, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model_id: env.CARTESIA_TTS_MODEL || MODULE_DEFAULTS.CARTESIA_TTS_MODEL,
      transcript: prompt, voice: { mode: 'id', id: TEST_STUDENT_VOICE_ID }, language: 'en',
      output_format: { container: 'raw', encoding: 'pcm_s16le', sample_rate: 16000 } }),
  });
  assert.ok(speech.ok, `Synthetic speech provider returned HTTP ${speech.status}`);
  const pcm = new Uint8Array(await speech.arrayBuffer());
  assert.ok(pcm.length > 1600, 'Synthetic speech is empty');
  console.log(`Synthetic learner audio: ${(pcm.length / 32000).toFixed(1)}s`);
  return pcm;
}

async function main() {
  const conn = await new Promise<DbConnection>((resolve, reject) => {
    DbConnection.builder().withUri(cfg.spacetimeUri).withDatabaseName(cfg.spacetimeDb)
      .onConnect(c => resolve(c)).onConnectError((_c, err) => reject(err)).build();
  });
  let sessionId: bigint | undefined;
  try {
    // audio_out is an event table: rows do not remain in the SDK cache.
    const audioEvents: AudioOut[] = [];
    conn.db.audioOut.onInsert((_ctx, audio) => { if (audio.sessionId === sessionId) audioEvents.push(audio); });
    await new Promise<void>((resolve, reject) => conn.subscriptionBuilder().onApplied(() => resolve())
      .onError(() => reject(new Error('Smoke subscription failed')))
      .subscribe(['learner', 'session', 'turn', 'phrase', 'reply_sentence', 'board_item', 'audio_out']
        .map(table => `SELECT * FROM ${table}`)));
    const name = `Synthetic smoke ${Date.now()}`;
    await conn.reducers.createTestUser({ name, age: 9, grade: 4, style: 'short explanations, animated diagrams' });
    const learner = await waitFor('synthetic learner', () => [...conn.db.learner.iter()].find(l => l.name === name));
    await conn.reducers.startSession({ learnerId: learner.id, taskText: prompts[0]! });
    const session = await waitFor('session', () => [...conn.db.session.iter()].find(s => s.learnerId === learner.id && s.active));
    sessionId = session.id;
    console.log(`Synthetic session ${session.id} in ${cfg.spacetimeDb}`);
    for (const [turnIndex, prompt] of prompts.entries()) {
      const pcm = await synthesizeStudent(prompt);
      const priorTurn = Math.max(-1, ...[...conn.db.turn.iter()].filter(t => t.sessionId === sessionId).map(t => t.idx));
      const previousAudioCount = audioEvents.length;
      // Same 150 ms chunks as microphone capture, sent without real-time pauses.
      for (let offset = 0, seq = 0; offset < pcm.length; offset += 4800, seq++) {
        await conn.reducers.pushAudio({ sessionId, phraseId: turnIndex + 1, seq, pcm: pcm.slice(offset, offset + 4800), final: offset + 4800 >= pcm.length });
      }
      const startedAt = Date.now();
      await conn.reducers.endTurn({ sessionId });
      const student = await waitFor('transcript', () => [...conn.db.turn.iter()].find(t => t.sessionId === sessionId && t.role === 'student' && t.idx > priorTurn && t.text.trim()));
      console.log(`STT ${Date.now() - startedAt}ms: ${student.text}`);
      const firstAudio = await waitFor('tutor audio', () => audioEvents.slice(previousAudioCount).find(a => a.pcm.length > 0));
      console.log(`First tutor audio available ${Date.now() - startedAt}ms after endTurn (${firstAudio.sampleRate}Hz)`);
      const tutor = await waitFor('completed tutor response', () => [...conn.db.turn.iter()].find(t => t.sessionId === sessionId && t.role === 'tutor' && t.idx > priorTurn && t.text.trim()));
      console.log(`Tutor: ${tutor.text}`);
      const sentences = [...conn.db.replySentence.iter()].filter(s => s.sessionId === sessionId && s.utteranceId === tutor.utteranceId).sort((a, b) => a.idx - b.idx);
      await waitFor('all tutor audio', () => {
        const audio = audioEvents;
        return sentences.every(s => audio.some(a => a.utteranceId === s.utteranceId && a.idx === s.idx && a.pcm.length > 0)) ? true : undefined;
      });
      const boards = [...conn.db.boardItem.iter()].filter(b => b.sessionId === sessionId && b.visible && b.kind === 'math_canvas' && b.utteranceId === tutor.utteranceId);
      assert.ok(boards.length, 'Tutor did not generate a math_canvas for the explicit visual request');
      const player = new SpeechCanvasPlayer();
      const items = boards.map(b => ({ id: b.id.toString(), order: b.idx, utteranceId: b.utteranceId.toString(), sentenceIdx: b.sentenceIdx, content: JSON.parse(b.content) }));
      const cues = new Map<string, number[]>();
      player.sync(items, cues, false);
      assert.equal(player.error, null, `Generated canvas failed preflight: ${player.error}`);
      assert.equal(player.director.getSnapshot().canvas.math, null, 'Canvas revealed before a speech cue');
      // Simulated playback cues/acknowledgments let the next synthetic turn proceed.
      // These are NOT microphone/speaker measurements; test sessions are labeled synthetic.
      for (const sentence of sentences) {
        const key = sentence.utteranceId.toString();
        cues.set(key, [...(cues.get(key) ?? []), sentence.idx]);
        player.sync(items, cues, false);
        assert.equal(player.error, null);
        await conn.reducers.markPlayed({ sessionId, utteranceId: sentence.utteranceId, idx: sentence.idx });
      }
      assert.ok(player.director.getSnapshot().canvas.math, 'Generated canvas never appeared');
      for (const item of items) for (const m of item.content.moments) {
        assert.ok((cues.get(item.utteranceId) ?? []).includes(item.sentenceIdx + m.sentenceOffset), 'Canvas refers to an unspoken sentence');
      }
      console.log(`PASS: ${sentences.length} spoken sentences, ${boards.length} valid canvas item(s), ordered cue checks. Playback acknowledgments simulated, browser playback not measured.`);
    }
  } finally {
    if (sessionId !== undefined) await conn.reducers.endSession({ sessionId });
    conn.disconnect();
  }
}

main().catch(error => {
  let message = error instanceof Error ? error.message : String(error);
  for (const [name, value] of Object.entries(env)) if (/(KEY|TOKEN|SECRET)/.test(name) && value) message = message.split(value).join('[redacted]');
  console.error(message);
  process.exitCode = 1;
});
