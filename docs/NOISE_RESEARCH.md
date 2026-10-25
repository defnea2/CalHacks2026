# Other voices around the computer: noise / background-voice suppression (research, 2026-10-25)

Research only; no code changed. Sources checked on 2026-10-25.

## Current pipeline (repo)
- `client/src/audio/AudioCapture.ts`: `getUserMedia({channelCount:1, echoCancellation, noiseSuppression, autoGainControl})`, all on (`?mic_aec=0`, `?mic_ns=0`, `?mic_agc=0`). No `voiceIsolation`.
- `vadMachine.ts`: Silero v5 (32 ms frames); speech start at P ≥ `VAD_THRESHOLD` 0.5 for `VAD_MIN_SPEECH_MS` 50; a phrase only starts `NOISE_SNR_DB` 10 dB above the tracked noise floor (`noise.ts`). Floor > −35 dBFS = "noisy": threshold +0.1, min speech 200 ms, headphone hint.
- Re-entry inside an open turn at 0.25 (`VAD_REENTRY_THRESHOLD`) and up to +1000 ms hold — both worsen a noisy room.
- Barge-in: P ≥ 0.7 for 400 ms while the tutor speaks; VAD only, no transcript check.
- Smart Turn: P(complete) ≥ 0.5 → end after 750 ms silence, else 900 ms fallback.
- Every `VOICE_DEFAULTS` / `CLIENT_DEFAULTS` key can be overridden by a lower-case URL parameter.

## Today (≤ 1 hour, no new tech)
1. **Wired/USB headset with a close (boom) mic** — strongest fix: ~20–30 dB more child voice over the hall; tutor audio in the headset also removes self-triggered barge-ins. Check `capture.mic.label` in the debug panel. Avoid Bluetooth (call profile).
2. **Tighter gates via URL parameters** (rehearse once in the hall):
   `?noise_snr_db=15&vad_threshold=0.6&vad_min_speech_ms=150&noisy_min_speech_ms=300&vad_reentry_threshold=0.45&vad_turn_hold_max_ms=400&barge_in_threshold=0.85&barge_in_min_ms=700&mic_agc=0`
   (`mic_agc=0` only with the headset; raise `noise_snr_db` to 18–20 if strangers still open phrases. Cost: quiet kids must speak up; barge-in ~1 s.)
3. **macOS Mic Mode → Voice Isolation** (Control Center while the mic is live): free, OS-level, removes other voices. Safari reportedly shows it; Chrome unverified — 2-minute test.
4. **Demo choreography:** one speaker, others step back; the noise hint is a talking point.
- Not today: Krisp, LiveKit, Agora (sign-up/approval or vendor SDK owning the mic track; regression risk for the E2E suite).

## After the hackathon (ranked)
1. **Background-voice removal in the browser before Silero:** Krisp JS SDK with BVC (commercial, access by request) or ai-coustics "Quail Voice Focus" (free dev keys claimed — unverified); Agora AINS 2.0.2 added background voice removal on 2026-06-24 (10k min/month free, then $0.59/1k min; tied to the Agora Web SDK track). Turn the browser's `noiseSuppression` off when a model runs.
2. **Transcript-confirmed barge-in:** duck the tutor instead of stopping; interrupt only when streaming ink-2 returns ≥ 2 real words within ~600 ms.
3. **Drop junk turns:** < 2 words, filler only, clearly unrelated chatter.
4. **Target-speaker check (child's voice enrolment):** ~5 s of speech → ECAPA-TDNN / WeSpeaker ONNX embedding (192-d, cosine); accept only matching phrases. Feasible in onnxruntime-web; per-phrase cost unmeasured; a second filter, multi-day job.
5. **`voiceIsolation: true` constraint:** free; Chrome 121+, effective only with OS support (initially some ChromeOS devices).

## Comparison
| Solution | Removes other voices? | In browser? | Free for demo? | Latency | Effort | Licence |
|---|---|---|---|---|---|---|
| Headset / directional mic | Yes (physically, best) | n/a | Yes | 0 | Minutes | n/a |
| URL-parameter tuning | Partly (quieter/farther voices) | Yes | Yes | +100–300 ms start, ~+300 ms barge-in | Minutes | Ours |
| Hold-to-talk | Yes while held | Yes | Yes | 0 | 0.5–1 h | Ours |
| Krisp JS SDK (NC + BVC) | Yes (BVC) | Yes (WASM) | No public tier | Low (unpublished) | 1–2 days after access | Commercial |
| LiveKit Krisp filter | BVC | Yes | Needs LiveKit Cloud | Low | High (needs LiveKit transport) | Commercial |
| Agora AINS 2.0.2 | Yes (since 2026-06-24) | Yes (WASM; not mobile; Safari discouraged) | 10k min/month | ~40 ms (LOW) | Medium | Commercial |
| ai-coustics Quail Voice Focus | Yes (vendor claim) | Web SDK claimed (unverified) | Free dev keys claimed | ~30 ms (vendor) | Medium | Commercial |
| Picovoice Koala | No (noise only) | Yes | Free tier | Low | Low–medium | Proprietary |
| RNNoise (WASM) | No (stationary noise) | Yes (~110 KB) | Yes | ~10 ms | Low | BSD |
| DeepFilterNet3 (WASM/ONNX) | No | Yes (~14 MB) | Yes | Tens of ms | Medium | MIT/Apache |
| Chrome `noiseSuppression` (on) | No | Yes | Yes | ~0 | Done | n/a |
| `voiceIsolation` constraint | "attempt" | Chrome 121+, few devices | Yes | ~0 | 1 line | n/a |
| macOS Voice Isolation | Yes | OS-level (Chrome unverified) | Yes | ~0 | 2 min | n/a |
| Speaker enrolment (ONNX) | Yes (by identity) | Yes | Yes | Tens of ms (est.) | Days | Apache (varies) |
| Cartesia ink | No background-voice option found (`min_volume` for ink-whisper only) | Server | n/a | n/a | n/a | n/a |

## Sources
- Krisp developers / JS SDK: https://krisp.ai/developers/ · https://sdk-docs.krisp.ai/
- Agora AI Noise Suppression (Web): https://docs.agora.io/en/realtime-media/rtc/build/enhance-the-audio-experience/ai-noise-suppression/web.md · pricing https://agora.io/en/price
- ChromeStatus voiceIsolation: https://chromestatus.com/api/v0/features?q=voiceIsolation · spec https://w3c.github.io/mediacapture-extensions/
- LiveKit enhanced noise cancellation: https://docs.livekit.io/transport/media/enhanced-noise-cancellation/
- Cartesia STT models / WebSocket (`min_volume`): https://docs.cartesia.ai/build-with-cartesia/stt-models.md · https://docs.cartesia.ai/api-reference/stt/websocket.md
- Fora Soft comparison (2026-06-02): https://www.forasoft.com/learn/ai-for-video-engineering/articles-ai/real-time-noise-suppression-krisp-rnnoise-deepfilternet-integration
- macOS Voice Isolation in browsers: https://connect.mozilla.org/t5/ideas/voice-isolation-on-macos/idc-p/71973
