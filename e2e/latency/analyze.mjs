// Joins one batch of latency runs and prints per-stage statistics + per-turn waterfalls.
//
// Inputs (all from the same batch):
//   <runs>/*.client.json     from run.mjs
//   <server.log>             `spacetime logs tutor-lat -n 20000 > server.log` (LAT lines)
//   <worker.log>             worker stdout (LAT lines)
//   <fake-llm.log>           fake-llm.mjs stdout (LAT lines)
// Usage: node e2e/latency/analyze.mjs <runsDir> <server.log> <worker.log> <fake-llm.log> [--json out.json]
// Clocks: browser performance.timeOrigin + t, module Date.now()/ctx.timestamp, worker Date.now():
// all the same machine clock.
import fs from 'node:fs';
import path from 'node:path';

const [runsDir, serverLog, workerLog, fakeLog, ...rest] = process.argv.slice(2);
const jsonOut = rest[0] === '--json' ? rest[1] : null;

const latLines = file =>
  fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .map(l => {
      const i = l.indexOf('LAT {');
      if (i < 0) return null;
      try {
        return JSON.parse(l.slice(i + 4));
      } catch {
        return null;
      }
    })
    .filter(Boolean);

const server = latLines(serverLog);
const worker = latLines(workerLog);
const fake = latLines(fakeLog);
const runs = fs
  .readdirSync(runsDir)
  .filter(f => f.endsWith('.client.json'))
  .map(f => JSON.parse(fs.readFileSync(path.join(runsDir, f), 'utf8')));

// ------------------------------------------------------------------ stats helpers
const stages = new Map(); // name -> {values, unit, note}
const add = (name, v, note = '') => {
  if (v === null || v === undefined || !Number.isFinite(v)) return;
  if (!stages.has(name)) stages.set(name, { values: [], note });
  stages.get(name).values.push(v);
};
const q = (arr, p) => {
  const a = [...arr].sort((x, y) => x - y);
  if (!a.length) return NaN;
  const i = Math.min(a.length - 1, Math.max(0, Math.ceil(p * a.length) - 1));
  return a[i];
};
const fmt = v => (Number.isFinite(v) ? (Math.abs(v) >= 100 ? v.toFixed(0) : v.toFixed(1)) : '-');
const sub = (a, b) => (a === null || a === undefined || b === null || b === undefined ? null : a - b);
const tsOf = e => (e ? (e.ts ?? e.now) : null);

const waterfalls = [];

for (const run of runs) {
  const sid = Number(run.sessionId);
  const P = t => run.perfOrigin + t; // perf -> wall ms
  const ev = run.events.map(e => ({ ...e, w: P(e.t) }));
  const of = type => ev.filter(e => e.type === type);
  const S = server.filter(x => x.s === sid);
  const sv = name => S.filter(x => x.ev === name);
  const W = worker.filter(x => x.s === sid);
  const wv = name => W.filter(x => x.ev === name);
  const frames = run.frames;
  const fByI = new Map(frames.map(f => [f.i, f]));
  const cfg = run.config?.voice ?? {};
  const hyst = run.config?.client?.VAD_HYSTERESIS ?? 0.15;
  const thr = cfg.VAD_THRESHOLD ?? 0.5;
  const noisy = /noisy/.test(run.wav);
  const tag = `${run.label}`;

  // ---------------------------------------------------------------- 1. capture & VAD
  frames.forEach((f, k) => {
    if (f.i === 0) add('vad.infer_first_ms', f.inferMs);
    else add('vad.infer_ms', f.inferMs);
    if (f.i > 0) add('vad.frame_cost_ms', f.done - f.arrive);
    if (k > 0 && frames[k - 1].i === f.i - 1) add('vad.frame_interval_ms', f.arrive - frames[k - 1].arrive);
  });
  const vadEv = of('lat.vad');
  const bargeFrames = new Set(vadEv.filter(e => e.kind === 'barge_in').map(e => e.frame));
  for (const s of vadEv.filter(e => e.kind === 'speech_start' && !bargeFrames.has(e.frame))) {
    const f = s.frame;
    // acoustic onset: walk back while the frame is not digital silence (fixtures are trimmed)
    let k = f;
    while (fByI.has(k - 1) && fByI.get(k - 1).lvl > -80) k--;
    if (!noisy) add('vad.speech_start_after_onset_ms', (f - k + 1) * 32, 'audio time from first non-silent frame to the decision frame end');
    // first frame >= threshold
    let j = f;
    while (fByI.has(j - 1) && fByI.get(j - 1).prob >= thr) j--;
    add('vad.speech_start_after_first_speechy_ms', (f - j + 1) * 32, 'VAD_MIN_SPEECH_MS=100 quantised to 32 ms frames');
  }
  for (const s of of('vad.speech_start')) add('vad.preroll_ms', s.prerollMs);
  const lastVoicedBefore = f => {
    let k = f;
    while (fByI.has(k) && fByI.get(k).prob < Math.max(0.05, thr - hyst)) k--;
    return k;
  };
  for (const pe of vadEv.filter(e => e.kind === 'phrase_end')) {
    const lv = lastVoicedBefore(pe.frame);
    add('vad.phrase_end_after_last_voiced_ms', (pe.frame - lv) * 32, `config VAD_PHRASE_MS=${cfg.VAD_PHRASE_MS}`);
  }
  for (const te of vadEv.filter(e => e.kind === 'turn_end')) {
    // last voiced frame before the turn end
    let k = te.frame;
    while (fByI.has(k) && fByI.get(k).prob < Math.max(0.05, thr - hyst)) k--;
    add('vad.turn_end_after_last_voiced_ms', (te.frame - k) * 32, `config VAD_TURN_MS=${cfg.VAD_TURN_MS}`);
  }

  // ---------------------------------------------------------------- 2. upload
  const pushes = of('lat.push');
  const sPush = sv('push');
  for (const p of pushes) {
    add(p.final ? 'up.push_final_rtt_ms' : 'up.push_rtt_ms', p.ms);
    const sp = sPush.find(x => x.p === p.phraseId && x.seq === p.seq);
    if (sp) add('up.push_oneway_ms', sp.ts - p.wall0, 'client call (Date.now, 1 ms res.) -> reducer tx timestamp');
    add(p.final ? 'up.push_final_bytes' : 'up.push_bytes', p.bytes);
  }
  // websocket frame overhead: up frames whose size is within 300 B above a push payload
  const ups = (run.wsFrames ?? []).filter(f => f.dir === 'up');
  const used = new Set();
  for (const p of pushes) {
    const fr = ups.find((f, i) => !used.has(i) && f.len >= p.bytes && f.len - p.bytes < 300 && Math.abs(f.wall - p.wall0) < 50 && used.add(i));
    if (fr) add('up.ws_overhead_bytes', fr.len - p.bytes, 'websocket payload bytes minus raw PCM bytes (BSATN envelope)');
  }
  for (const pe of vadEv.filter(e => e.kind === 'phrase_end')) {
    const fin = pushes.find(p => p.final && Math.abs(p.wall0 - pe.w) < 100);
    const sfin = fin && sPush.find(x => x.p === fin.phraseId && x.final);
    if (sfin) add('up.final_chunk_commit_after_phrase_end_ms', sfin.ts - pe.w);
  }
  const turnEnds = of('vad.turn_end');
  const sEnd = sv('endTurn');
  const hooks = run.hooks ?? { rows: [], dom: [] };
  const rows = (hooks.rows ?? []).map(r => ({ ...r, w: P(r.t) }));
  const dom = (hooks.dom ?? []).map(r => ({ ...r, w: P(r.t) }));
  turnEnds.forEach((te, k) => {
    const se = sEnd[k];
    if (se) add('up.endturn_oneway_ms', se.ts - te.w);
    const closing = rows.find(r => r.kind === 'turn.update' && r.status === 'closing' && r.w > te.w);
    if (closing) add('up.endturn_to_closing_visible_ms', closing.w - te.w);
  });
  for (const r of of('reducer.ok')) if (['endTurn', 'markPlayed', 'reportNoise', 'interrupt'].includes(r.name)) add(`up.reducer_rtt_${r.name}_ms`, r.ms);

  // ---------------------------------------------------------------- 3. scheduler & procedures
  for (const e of sv('stt.enter')) {
    add('sched.stt_due_to_start_ms', e.ts - e.due);
    const fs0 = S.find(x => x.ev === 'stt.fetchStart' && x.p === e.p && x.now >= e.now);
    const fe = S.find(x => x.ev === 'stt.fetchEnd' && x.p === e.p && x.now >= e.now);
    const ex = S.find(x => x.ev === 'stt.exit' && x.p === e.p && x.now >= e.now);
    const rd = S.find(x => x.ev === 'stt.read' && x.p === e.p && x.now >= e.now);
    add('proc.stt_read_tx_ms', sub(rd?.now, e.ts), 'withTx: find phrase + join audio_in chunks');
    add('proc.stt_before_http_ms', sub(fs0?.now, e.ts), 'entry -> HTTP start (read tx + concat + multipart)');
    add('ext.stt_http_ms', sub(fe?.now, fs0?.now));
    add('proc.stt_after_http_ms', sub(ex?.now, fe?.now), 'JSON parse + finishPhrase withTx commit');
    if (rd) add('proc.stt_phrase_bytes', rd.bytes);
  }
  const ttsSpans = [];
  for (const e of sv('tts.enter')) {
    add('sched.tts_due_to_start_ms', e.ts - e.due);
    const m = x => x.u === e.u && x.idx === e.idx && x.now >= e.now;
    const rd = S.find(x => x.ev === 'tts.read' && m(x));
    const fs0 = S.find(x => x.ev === 'tts.fetchStart' && m(x));
    const fe = S.find(x => x.ev === 'tts.fetchEnd' && m(x));
    const by = S.find(x => x.ev === 'tts.bytes' && m(x));
    const ins = S.find(x => x.ev === 'tts.insert' && m(x));
    const ex = S.find(x => x.ev === 'tts.exit' && m(x));
    add('proc.tts_read_tx_ms', sub(rd?.now, e.ts), 'withTx: sentence still pending?');
    add('proc.tts_before_http_ms', sub(fs0?.now, e.ts));
    add('ext.tts_http_ms', sub(fe?.now, fs0?.now));
    add('proc.tts_body_ms', sub(by?.now, fe?.now), 'res.bytes()');
    add('proc.tts_after_http_to_insert_ms', sub(ins?.now, fe?.now));
    add('proc.tts_commit_ms', sub(ex?.now, ins?.now), 'audio_out + reply_sentence + session commit');
    if (ins) add('down.audio_pcm_bytes', ins.bytes);
    if (fs0 && fe) ttsSpans.push([fs0.now, fe.now, e.u]);
  }
  // TTS concurrency: max simultaneously open HTTP spans per utterance
  for (const u of new Set(ttsSpans.map(s => s[2]))) {
    const sp = ttsSpans.filter(s => s[2] === u);
    let max = 0;
    for (const [a] of sp) max = Math.max(max, sp.filter(([x, y]) => x <= a && y > a).length);
    add('sched.tts_parallel_http_per_utterance', max, 'max overlapping TTS HTTP calls of one utterance');
  }
  for (const e of sv('ctx.enter')) {
    const ex = S.find(x => x.ev === 'ctx.exit' && x.now >= e.now);
    add('proc.buildContext_ms', sub(ex?.now, e.ts));
  }

  // ---------------------------------------------------------------- 4. downlink & render
  const audioIn = of('lat.audioIn');
  for (const a of audioIn) {
    const ins = sv('tts.insert').find(x => String(x.u) === a.utteranceId && x.idx === a.idx);
    const ex = sv('tts.exit').length ? S.find(x => x.ev === 'tts.exit' && String(x.u) === a.utteranceId && x.idx === a.idx) : null;
    if (ins) add('down.audio_insert_to_client_ms', a.w - ins.now, 'tts.insert log (in tx) -> client onInsert; includes commit + fan-out + ws + decode');
    if (ex) add('down.audio_commit_to_client_ms', a.w - ex.now, 'after procedure commit -> client onInsert');
  }
  for (const r of rows.filter(r => r.kind === 'sentence.insert')) {
    const sa = sv('addSentence').find(x => String(x.u) === r.u && x.idx === r.idx);
    if (sa) add('down.sentence_row_ms', r.w - sa.ts, 'addSentence tx -> client onInsert');
  }
  // tutor captions are shown when the sentence starts playing (reveal sync)
  for (const ps of of('audio.play_start')) {
    const cap = dom.find(d => d.kind === 'caption' && d.key.startsWith(`cap:${ps.utteranceId}:${ps.idx}:`));
    if (cap) add('render.caption_after_play_start_ms', cap.w - ps.w, 'play_start timer -> caption in DOM (session tab)');
    if (run.observer) {
      const oc = run.observer.dom.find(d => d.kind === 'caption' && d.key.startsWith(`cap:${ps.utteranceId}:${ps.idx}:`));
      if (oc) add('down.observer_caption_after_play_start_ms', oc.wall - ps.w, 'session play_start -> markPlayed -> observer DOM (fan-out to a 2nd client)');
    }
  }
  for (const r of rows.filter(r => r.kind === 'phrase.update' && r.status === 'done')) {
    const d = dom.find(x => x.key === `phr:${r.p}:done`);
    if (d) add('render.phrase_text_ms', d.w - r.w, 'phrase row (transcript) -> caption in DOM');
    const fp = sv('finishPhrase').find(x => x.p === r.p);
    if (fp) add('down.phrase_text_row_ms', r.w - fp.ts, 'finishPhrase tx -> client onUpdate');
  }
  for (const r of rows.filter(r => r.kind === 'board.insert')) {
    const sb = sv('showBoardItem').filter(x => x.ts <= r.w).pop();
    if (sb) add('down.board_row_ms', r.w - sb.ts);
    const b = dom.find(d => d.kind === 'board' && d.key.startsWith(`board:${r.id}:`));
    if (b) add('render.board_ms', b.w - r.w, 'onInsert -> board item in DOM');
  }
  for (const r of rows.filter(r => r.kind === 'turn.update' && r.status === 'ready')) {
    const sr = sv('turnReady').find(x => x.turn === r.idx);
    if (sr) add('down.turn_ready_row_ms', r.w - sr.ts);
  }
  const downs = (run.wsFrames ?? []).filter(f => f.dir === 'down');
  for (const f of downs) if (f.len > 20000) add('down.ws_audio_frame_bytes', f.len);
  const comp = {};
  for (const f of downs) comp[f.b0] = (comp[f.b0] ?? 0) + 1;

  // ---------------------------------------------------------------- 5. worker
  const sReady = sv('turnReady');
  for (const seen of wv('w.turnReadySeen')) {
    const sr = sReady.find(x => x.turn === seen.turn);
    if (sr) add('w.turn_ready_seen_ms', seen.now - sr.ts, 'turnReady tx -> worker onUpdate');
  }
  for (const rs of wv('w.runStart')) {
    const seen = wv('w.turnReadySeen').find(x => x.turn === rs.turn && x.now <= rs.now + 1);
    if (seen && !rs.held) add('w.seen_to_run_start_ms', rs.now - seen.now);
    const cd = wv('w.ctxDone').find(x => x.u === rs.u);
    const ce = S.find(x => x.ev === 'ctx.enter' && x.now >= rs.now - 2);
    add('w.buildContext_rtt_ms', sub(cd?.now, rs.now), 'procedure call -> result (incl. image when first)');
    add('w.buildContext_call_hop_ms', sub(ce?.ts, rs.now));
    const ls = wv('w.llmStream').find(x => x.u === rs.u);
    add('w.prompt_build_ms', sub(ls?.now, cd?.now));
    const lr = worker.find(x => x.ev === 'w.llmRequest' && ls && x.now >= ls.now);
    const fr = lr && fake.find(x => x.ev === 'fake.request' && x.firstByteAt >= lr.now - 2);
    add('w.llm_sdk_to_server_ms', sub(fr?.firstByteAt, ls?.now), 'llm.stream() -> first request byte at the local fake LLM');
    if (fr) add('w.llm_prompt_bytes', fr.bodyBytes);
  }
  // chunker look-ahead: chunk emitted vs the token that ended it
  const wtok = worker.filter(x => x.ev === 'w.token');
  for (const c of wv('w.chunk')) {
    const endTok = [...wtok].reverse().find(t => t.now <= c.now && t.end);
    if (endTok) add('w.chunker_lookahead_ms', c.now - endTok.now, 'sentence-final token -> chunk emitted (needs the next token)');
  }
  const chunks = wv('w.chunk').filter(c => true);
  wv('w.addSentenceCall').forEach(a => {
    const ok = wv('w.addSentenceOk').find(x => x.u === a.u && x.idx === a.idx);
    add('w.addSentence_rtt_ms', sub(ok?.now, a.now));
    const sa = sv('addSentence').find(x => x.u === a.u && x.idx === a.idx);
    add('w.addSentence_oneway_ms', sub(sa?.ts, a.now));
  });
  const calls = wv('w.addSentenceCall');
  const byU = {};
  for (const c of chunks) (byU[c.u] ??= []).push(c);
  for (const [u, cs] of Object.entries(byU)) {
    cs.forEach((c, i) => {
      const a = calls.find(x => String(x.u) === u && x.idx === i);
      if (a) add(i === 0 ? 'w.first_sentence_outbox_wait_ms' : 'w.sentence_outbox_wait_ms', a.now - c.now, 'chunk emitted -> addSentence sent (ordered outbox; idx 0 waits for beginUtterance)');
    });
  }
  for (const b of wv('w.beginCall')) {
    const ok = wv('w.beginOk').find(x => x.u === b.u);
    add('w.beginUtterance_rtt_ms', sub(ok?.now, b.now));
  }
  for (const t of wv('w.toolCallEv')) {
    const sent = fake.filter(x => x.ev === 'fake.toolSent' && x.now <= t.now + 1).pop();
    add('w.tool_args_done_to_event_ms', sub(t.now, sent?.now), 'last argument delta sent by the LLM -> tool_call event in the worker');
    const st = wv('w.toolStart').find(x => x.u === t.u && x.now >= t.now);
    add('w.tool_outbox_wait_ms', sub(st?.now, t.now));
    const ok = wv('w.toolOk').find(x => x.u === t.u && x.now >= t.now);
    add('w.tool_reducer_rtt_ms', sub(ok?.now, st?.now));
    const b = dom.find(d => d.kind === 'board' && d.w >= t.now);
    if (b) add('w.tool_event_to_board_dom_ms', b.w - t.now);
  }

  // ---------------------------------------------------------------- 6. playback
  const sched = of('audio.scheduled');
  for (const a of audioIn) {
    const s = sched.find(x => x.utteranceId === a.utteranceId && x.idx === a.idx);
    if (s) {
      add('play.receive_to_scheduled_ms', s.w - a.w, 'onInsert -> buffer scheduled (in-order blocks)');
      add('play.prep_ms', s.prepMs, 'PCM16 -> float, trim, fades, AudioBuffer');
    }
  }
  for (const s of sched) {
    if (s.idx === 0) add('play.lead_ms', s.inMs, 'scheduled -> start (PLAYBACK_LEAD_MS)');
    const prev = sched.find(x => x.utteranceId === s.utteranceId && x.idx === s.idx - 1);
    if (prev) add('play.extra_gap_ms', (s.startAt - prev.endAt) * 1000 - (run.config?.playback?.SENTENCE_PAUSE_MS ?? 200), 'gap beyond SENTENCE_PAUSE_MS (late audio)');
    if (s.outputLatency) add('play.output_latency_ms', s.outputLatency * 1000);
  }
  for (const b of of('vad.barge_in')) {
    const fl = of('audio.flush').find(x => x.w >= b.w && x.reason === 'barge_in');
    if (fl) add('play.barge_in_to_flush_ms', fl.w - b.w);
    const si = sv('interrupt')[0];
    if (si) add('up.barge_in_to_interrupt_reducer_ms', si.ts - b.w);
    const bf = vadEv.find(e => e.kind === 'barge_in');
    if (bf) {
      let k = bf.frame;
      while (fByI.has(k - 1) && fByI.get(k - 1).lvl > -80) k--;
      add('vad.barge_in_after_onset_ms', (bf.frame - k + 1) * 32, 'BARGE_IN_MIN_MS=400 + onset lag');
    }
  }

  // ---------------------------------------------------------------- 7. end-to-end waterfall (first reply)
  for (let k = 0; k < turnEnds.length; k++) {
  const te = turnEnds[k];
  const endT = sEnd[k];
  const ready = endT && sReady.find(x => x.turn === endT.turn);
  const seen = ready && wv('w.turnReadySeen').find(x => x.turn === ready.turn);
  const rs = seen && (wv('w.runStart').filter(x => x.turn === seen.turn && !x.held).pop() ?? wv('w.runStart').filter(x => x.turn === seen.turn).pop());
  const u = rs?.u;
  const play0 = u && of('audio.play_start').find(x => x.idx === 0 && x.utteranceId === String(u));
  if (te && play0) {
    const pe = [...vadEv.filter(e => e.kind === 'phrase_end')].filter(e => e.w <= te.w).pop();
    const lastVoicedFrame = pe ? fByI.get(lastVoicedBefore(pe.frame)) : null;
    const speechEnd = lastVoicedFrame ? P(lastVoicedFrame.arrive) : null;
    const peW = pe?.w;
    const finP = pushes.filter(p => p.final && p.wall0 <= te.w + 5).pop();
    const sFin = finP && sPush.find(x => x.p === finP.phraseId && x.final);
    const sttE = finP && sv('stt.enter').find(x => x.p === finP.phraseId);
    const sttFS = finP && S.find(x => x.ev === 'stt.fetchStart' && x.p === finP.phraseId);
    const sttFE = finP && S.find(x => x.ev === 'stt.fetchEnd' && x.p === finP.phraseId);
    const cd = wv('w.ctxDone').find(x => x.u === u);
    const ls = wv('w.llmStream').find(x => x.u === u);
    const lr = ls && worker.find(x => x.ev === 'w.llmRequest' && x.now >= ls.now);
    const fr = lr && fake.find(x => x.ev === 'fake.request' && x.firstByteAt >= lr.now - 2);
    const c0 = wv('w.chunk').find(x => x.u === u);
    const endTok = c0 && [...wtok].reverse().find(t => t.now <= c0.now && t.end);
    const a0 = wv('w.addSentenceCall').find(x => x.u === u && x.idx === 0);
    const sa0 = sv('addSentence').find(x => x.u === u && x.idx === 0);
    const t0 = sv('tts.enter').find(x => x.u === u && x.idx === 0);
    const tfs = S.find(x => x.ev === 'tts.fetchStart' && x.u === u && x.idx === 0);
    const tfe = S.find(x => x.ev === 'tts.fetchEnd' && x.u === u && x.idx === 0);
    const tin = S.find(x => x.ev === 'tts.insert' && x.u === u && x.idx === 0);
    const ain = audioIn.find(x => x.utteranceId === String(u) && x.idx === 0);
    const sch = sched.find(x => x.utteranceId === String(u) && x.idx === 0);
    const sttPathCritical = ready && endT && sttFE ? sttFE.now > endT.ts : null;
    const steps = [
      ['[turn-end path] speech end -> turn_end detected (VAD_TURN_MS)', 'policy', sub(te.w, speechEnd)],
      ['[turn-end path] turn_end -> endTurn committed', 'internal', sub(tsOf(endT), te.w)],
      ['[STT path] speech end (last voiced frame) -> phrase_end', 'policy', sub(peW, speechEnd)],
      ['[STT path] phrase_end -> final chunk committed', 'internal', sub(tsOf(sFin), peW)],
      ['[STT path] final chunk -> stt procedure starts', 'internal', sub(tsOf(sttE), tsOf(sFin))],
      ['[STT path] stt procedure -> HTTP start', 'internal', sub(sttFS?.now, tsOf(sttE))],
      ['[STT path] STT HTTP (Cartesia)', 'external', sub(sttFE?.now, sttFS?.now)],
      ['[STT path] STT response -> finishPhrase committed', 'internal', sub(S.find(x => x.ev === 'finishPhrase' && x.p === finP?.phraseId)?.ts, sttFE?.now)],
      [`=> turn ready (${sttPathCritical ? 'STT path' : 'turn-end path'} critical), from speech end`, 'sum', sub(tsOf(ready), speechEnd)],
    ];
    // when the turn-end wait is longer than the STT path, the wait is the critical part
    const turnEndPath = sub(tsOf(endT), speechEnd);
    const sttPath = sub(tsOf(ready), speechEnd);
    const steps2 = [
      ['turn ready -> worker sees it', 'internal', sub(seen?.now, tsOf(ready))],
      ['worker: seen -> buildContext done', 'internal', sub(cd?.now, seen?.now)],
      ['worker: prompt build -> request at LLM', 'internal', sub(fr?.firstByteAt, cd?.now)],
      ['LLM: request -> sentence-final token', 'external', sub(endTok?.now, fr?.firstByteAt)],
      ['chunker look-ahead (next token)', 'external*', sub(c0?.now, endTok?.now)],
      ['chunk -> addSentence sent (outbox/beginUtterance)', 'internal', sub(a0?.now, c0?.now)],
      ['addSentence -> committed', 'internal', sub(tsOf(sa0), a0?.now)],
      ['tts_job due -> procedure starts', 'internal', sub(tsOf(t0), tsOf(sa0))],
      ['tts procedure -> HTTP start', 'internal', sub(tfs?.now, tsOf(t0))],
      ['TTS HTTP (Cartesia)', 'external', sub(tfe?.now, tfs?.now)],
      ['TTS response -> audio_out insert', 'internal', sub(tin?.now, tfe?.now)],
      ['audio_out -> client onInsert', 'internal', sub(ain?.w, tin?.now)],
      ['onInsert -> scheduled', 'internal', sub(sch?.w, ain?.w)],
      ['scheduled -> playback starts (lead)', 'internal', sub(play0.w, sch?.w)],
    ];
    waterfalls.push({
      tag: `${tag} turn ${endT.turn}${rs.held ? ' (preemptive)' : ''}`,
      sid,
      speechEnd,
      turnEndWait: sub(te.w, speechEnd),
      turnEndPath,
      sttPath,
      sttPathCritical,
      readyFromSpeechEnd: sub(tsOf(ready), speechEnd),
      total: sub(play0.w, speechEnd),
      fromTurnEnd: sub(play0.w, te.w),
      steps,
      steps2,
      // critical path segments (ms) for the summary
      crit: {
        policy: sttPathCritical ? sub(peW, speechEnd) : sub(te.w, speechEnd),
        sttHttp: sttPathCritical ? sub(sttFE?.now, sttFS?.now) : 0,
        llm: sub(c0?.now, fr?.firstByteAt),
        ttsHttp: sub(tfe?.now, tfs?.now),
        total: sub(play0.w, speechEnd),
      },
    });
    add('e2e.speech_end_to_first_audio_ms', sub(play0.w, speechEnd));
    add('e2e.turn_end_to_first_audio_ms', sub(play0.w, te.w));
    add('e2e.turn_ready_to_first_audio_ms', sub(play0.w, tsOf(ready)));
  }
  }
  run._comp = comp;
}

// ------------------------------------------------------------------ cross-session concurrency
{
  const sids = new Set(runs.map(r => Number(r.sessionId)));
  const spans = [];
  for (const e of server.filter(x => sids.has(x.s) && (x.ev === 'tts.fetchStart' || x.ev === 'stt.fetchStart'))) {
    const end = server.find(x => x.ev === e.ev.replace('Start', 'End') && x.s === e.s && x.now >= e.now && (e.ev.startsWith('stt') ? x.p === e.p : x.u === e.u && x.idx === e.idx));
    if (end) spans.push([e.now, end.now, e.s]);
  }
  let max = 0;
  let maxSessions = 0;
  for (const [a] of spans) {
    const open = spans.filter(([x, y]) => x <= a && y > a);
    max = Math.max(max, open.length);
    maxSessions = Math.max(maxSessions, new Set(open.map(o => o[2])).size);
  }
  add('sched.global_parallel_http', max, 'max overlapping STT+TTS HTTP calls across all sessions of the batch');
  add('sched.global_parallel_http_sessions', maxSessions, 'sessions involved in that overlap');
}

// ------------------------------------------------------------------ output
const rowsOut = [];
for (const [name, { values, note }] of stages) {
  rowsOut.push({ name, n: values.length, p50: q(values, 0.5), p95: q(values, 0.95), max: Math.max(...values), min: Math.min(...values), mean: values.reduce((a, b) => a + b, 0) / values.length, note });
}
console.log(`runs: ${runs.map(r => `${r.label}(s${r.sessionId})`).join(', ')}`);
console.log(`downlink first-byte histogram (compression tag): ${JSON.stringify(runs.map(r => r._comp))}\n`);
console.log('| stage | n | p50 | p95 | max | min | note |');
console.log('| --- | --- | --- | --- | --- | --- | --- |');
for (const r of rowsOut) console.log(`| ${r.name} | ${r.n} | ${fmt(r.p50)} | ${fmt(r.p95)} | ${fmt(r.max)} | ${fmt(r.min)} | ${r.note} |`);
for (const w of waterfalls) {
  console.log(`\n### ${w.tag} (session ${w.sid}): speech end -> first audio ${fmt(w.total)} ms (turn_end -> first audio ${fmt(w.fromTurnEnd)} ms)`);
  console.log(`turn-end path ${fmt(w.turnEndPath)} ms, STT path to ready ${fmt(w.sttPath)} ms, ready at ${fmt(w.readyFromSpeechEnd)} ms, STT critical: ${w.sttPathCritical}`);
  for (const [k, kind, v] of [...w.steps, ...w.steps2]) console.log(`  ${kind.padEnd(9)} ${fmt(v).padStart(7)}  ${k}`);
}
if (jsonOut) fs.writeFileSync(jsonOut, JSON.stringify({ stages: rowsOut, waterfalls }, null, 1));
