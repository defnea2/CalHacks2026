# Two-minute demo

Goal: show a child learning by voice with a canvas that moves with the tutor's words, then the
teacher's classroom with simulated students, AI groups and live observation, and say why it is all
SpacetimeDB. Architecture background: [ARCHITECTURE.md](ARCHITECTURE.md).

## Preflight (10 minutes before)

- [ ] `.env` has `CARTESIA_API_KEY`, `ANTHROPIC_API_KEY`, `OPENROUTER_API_KEY`, `OPENROUTER_MODEL`,
      and for STT `STT_BASE_URL=https://api.cartesia.ai` + `CARTESIA_STT_MODEL=ink-whisper` (or the
      public PHP proxy URL with `ink-2`). The local stt-proxy on 127.0.0.1 is not reachable from
      SpacetimeDB.
- [ ] Server: `pnpm stdb:start` (or `pnpm dev:voice`, which does everything below).
- [ ] Publish: `pnpm stdb:publish` (after any `.env` change: module env is set at publish time).
- [ ] Worker: `pnpm worker`; its log says `worker: anthropic claude-haiku-5-5 ... reply mode lesson`.
- [ ] Client: `pnpm dev` → http://127.0.0.1:5175. In a session the tutor status line reads
      "Connected to claude-haiku-5-5" (`agent_status` heartbeat).
- [ ] stt-proxy only if you use the PHP/public proxy (`curl https://<host>/stt-proxy.php/health`).
- [ ] Prepare: one student ("Mia", 9, grade 4) and one teacher ("Ms. Park") already created, so the
      demo does not start with forms.
- [ ] Warm-up: one short voice turn in a throwaway session (first procedure runs after a publish are
      slower; Smart Turn loads after the mic starts).
- [ ] **Headphones on** (the tutor's voice in the laptop mic can trigger barge-in). Chrome, microphone permission granted for 127.0.0.1:5175.
- [ ] `?miccheck` shows the meter moving and noise `quiet` or `moderate`.
- [ ] Two browser windows side by side: student (left), teacher (right). Zoom 90 % if the canvas is cut.
- [ ] Open the fallback tab `http://127.0.0.1:5175/?lesson` in the background.

## Script

### 0:00–0:15 Pitch (entry page `/`)

> "Kids 8 to 12 get stuck on homework because they miss the idea, not the arithmetic. Our tutor
> talks with them and explains with pictures that move exactly when it says the words: first an
> intuitive picture, then the notation, then a task they solve themselves. Teachers can run a whole
> class with it. And the whole backend is one SpacetimeDB module."

### 0:15–0:55 Student by voice (left window)

1. `/` → **I'm a student** → pick **Mia** → **On my own · Learn by myself**.
2. Task: `Why is 1/4 + 2/4 not 3/8?` (optionally attach a photo of the task) → **Start my lesson**.
3. **Start talking**. The tutor greets her and names the task (authored opening, ~0.5 s).
4. Say: *"I added the tops and the bottoms and got three eighths."*
5. While it answers, point at:
   - the avatar thinking (dots) while Claude plans, then speaking with the audio;
   - pieces appearing on the canvas **at the word** the tutor says;
   - the check question at the end (choice buttons or "check my picture").
6. Answer by voice (or click a choice). Optionally interrupt the tutor mid-sentence to show barge-in.

> "Everything you saw went through SpacetimeDB: audio chunks up as reducer calls, speech-to-text and
> text-to-speech run in scheduled procedures, every picture is compiled and validated by a reducer
> against the canvas the child actually sees, and audio comes back as event rows. No backend server;
> the client is static files."

### 0:55–1:45 Teacher classroom (right window)

1. `/` → **I'm a teacher** → **Ms. Park**.
2. Class setup: Learning goals `Add fractions with the same denominator`; Content to cover
   `1/4 + 2/4, 2/6 + 3/6`; How to teach `Use pictures first, short sentences`;
   **Simulated students: 6** → **Start class session**.
3. (Optional) In the left window Mia clicks **Wait for my teacher** before the start: she is pulled
   into the class automatically.
4. Dashboard (`?class=<id>`): six simulated students start talking to the real tutor in text mode;
   their latest messages appear greyed out on the cards.
5. After ~30 s (or **Refresh**): the class summary on top and groups of exactly 2 or 4 students with
   a short name and status ("Adds the bottoms", ...).

> "Each simulated student is a real user in the database with its own memory, written by Claude from
> a persona with typical misconceptions. The summary and groups come from one Claude call inside a
> SpacetimeDB procedure, every 30 seconds, and the group sizes are enforced in code."

6. Hover a student card → **Observe**: the student's live screen (transcript + canvas). **Next →** to
   jump to the next student; **Stop observing** (Esc).

> "Observing costs us nothing: it is the same component subscribed to the same rows as the student's
> own tab. While the teacher watches, the dashboard pauses its refresh."

### 1:45–2:00 Close

> "One SpacetimeDB module holds the state, validates every model output, schedules speech, memory,
> simulated students and the dashboard, and every screen is just a subscription. About 100 ms of our
> own overhead per voice turn; turn end to first audio around 2.5 seconds."

**End class session** → **End for everyone** if there is time (students go back to the waiting room).

## Fallbacks

| Problem | Do this |
| --- | --- |
| Slow or flaky network on voice | Start the lesson with **Type instead of talking** (or `?voice=0`): same lesson pipeline, no STT/TTS; text plays with Pause / Next / Replay |
| STT returns nothing / mic trouble | Type in the session's text box instead; check `?miccheck` |
| "Tutor offline: start the worker." | Restart `pnpm worker`; a ready turn without a reply is answered again after 12 s |
| LLM down entirely | `?lesson` → **Equal groups** (offline sample) → choose **2 + 3** → **Show another way** → move an object into a basket → answer **six**; also **Comparing decimals**, **Where does a puddle go?**, **Open math studio**. `?canvasPreview` needs no database or keys |
| Dashboard still empty | Press **Refresh** (needs at least one student turn); with no summary yet, cards are listed under "Not grouped yet" |
| Simulation too slow | Use 4 simulated students; at most 4 student-LLM calls run at once |
| Echo / tutor interrupts itself | Headphones; or `?barge_in_threshold=0.85` |
| Everything stuck | `pnpm dev:voice -- --clear` resets the database (recreate the demo users) |

## What to have open for questions

- [ARCHITECTURE.md](ARCHITECTURE.md) sections 1 (data path), 4 (voice turn diagram), 9 (classroom),
  11 (why SpacetimeDB-idiomatic).
- Debug panel in the session (hide with `?debug=0`): per-turn latency table from `turn_metrics`.
- `spacetime logs --server local voice-tutor` for live procedure logs (LLM latency and tokens per call).
