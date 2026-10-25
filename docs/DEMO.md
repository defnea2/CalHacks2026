# Two-minute demo

Goal: show a child learning by voice with a canvas that moves with the tutor's words, then the
teacher's classroom with simulated students, AI groups and live observation, and say why it is all
SpacetimeDB. Architecture background: [ARCHITECTURE.md](ARCHITECTURE.md).

## Before the demo (demo database `voice-tutor`)

The demo database `voice-tutor` is already published with the final module and seeded with the demo
users below (no sessions, no class running). Start everything from the **main checkout**:

```bash
pnpm dev:voice        # SpacetimeDB (if not running) + publish + bindings + worker + client on :5175
```

`pnpm dev:voice` (`scripts/dev.mjs`) publishes **without** `--clear`, so the seeded users stay.
(`pnpm dev` alone only starts the client.) Only `pnpm dev:voice -- --clear` or
`node scripts/publish.mjs --clear` wipes the database; then re-seed:

```bash
node scripts/seed-demo.mjs            # idempotent: creates missing users, skips existing ones
node scripts/seed-demo.mjs --dry-run  # show what it would do
```

Change names, ages, grades or styles in **`scripts/demo-seed.json`** and re-run the script. Users are
matched by name: a new name is added, an existing one is never changed (the script prints the
difference). To apply changes to an existing user: `node scripts/publish.mjs --clear`, then
`node scripts/seed-demo.mjs`. `SPACETIME_DB=<name>` seeds another local database.

### Seeded users

| Who | Age | Grade | Learning style | Demo role |
| --- | --- | --- | --- | --- |
| Ava Chen | 9 | 4 | pictures first, short hints | self-learning flow ("On my own"), fractions |
| Sam Rivera | 11 | 6 | step by step, likes to check with numbers | self-learning flow, decimals |
| Priya Patel | 8 | 3 | short sentences, lots of encouragement, pictures first | "Wait for my teacher" flow |
| Ms. Park | | | teacher | runs the class |
| Mr. Alvarez | | | teacher (spare) | second class / backup |

No seed memory notes: the module has no client reducer for them (notes are written only by the
worker through `remember` during a session, or by memory extraction). The tutor sees the learning
style from the start; after the first real session it also remembers what happened. The 20
simulated classroom students (`shared/src/classroom/simStudents.ts`) are created when a class
starts and have their own seed memory; they never appear in the student picker.

### Copy-paste: student tasks (homework box on "Start my lesson")

Each one is matched to a library topic by keywords (no LLM call, so the lesson starts fast):

| Task text | Library topic |
| --- | --- |
| `Expand 2/3 so the bottom number is 12.` | fractions-expand |
| `Why is 1/4 + 2/4 not 3/8?` | fractions-add-same |
| `What is 1/5 + 2/5?` | fractions-add-same |
| `Which is bigger, 0.3 or 0.25? Explain why.` | decimals-tenths |
| `Lily says 0.25 is bigger than 0.3 because 25 is bigger than 3. Is she right?` | decimals-tenths |
| `Which is bigger, 3/4 or 2/3?` | fractions-compare |
| `Is 2/4 the same as 1/2?` | fractions-expand |
| `Share 12 cookies equally between 3 friends.` | division-sharing |
| `What is the value of the digit 4 in 348?` | place-value |

Suggested pairing: Ava → `Expand 2/3 so the bottom number is 12.`; Sam →
`Which is bigger, 0.3 or 0.25? Explain why.`

Things the child can say/type after the explanation: `I think I multiply the bottom by 4?` ·
`I added the tops and the bottoms and got three eighths.` · `0.25 is bigger because 25 is more than 3.` ·
`I don't know.` · `Show me another way.`

### Copy-paste: teacher class instructions (Ms. Park, class setup)

**Class A, fractions (default):**

- Learning goals: `Add fractions with the same denominator`
- Content to cover: `1/4 + 2/4, 2/6 + 3/6, 1/5 + 2/5`
- How to teach: `Use pictures first, short sentences. Explain why the bottom number stays the same.`
- Simulated students: `6`

**Class B, decimals (alternative):**

- Learning goals: `Compare decimals using tenths and hundredths`
- Content to cover: `Compare 0.3 and 0.25, then 0.5 and 0.45`
- How to teach: `Use a hundred grid or money. Let the child say which is bigger before showing the numbers.`
- Simulated students: `6`

**Class C, equivalent fractions (alternative):**

- Learning goals: `Find equivalent fractions by multiplying top and bottom`
- Content to cover: `Expand 2/3 to twelfths, 3/4 to eighths`
- How to teach: `Pizza or chocolate bar pictures first, then the rule. One step at a time.`
- Simulated students: `4`

The "Content to cover" text becomes the task of every linked session (the tutor names it in its
opening), so keep it as concrete fractions/decimals like above.

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
- [ ] Seeded users present (see "Before the demo"): the student picker shows Ava Chen, Sam Rivera,
      Priya Patel; the teacher picker Ms. Park, Mr. Alvarez. Missing? `node scripts/seed-demo.mjs`.
- [ ] Warm-up: one short voice turn in a throwaway session (first procedure runs after a publish are
      slower; Smart Turn loads after the mic starts). Use Sam Rivera for it, so Ava's first lesson in
      the demo has no earlier session in her memory (the tutor would refer to it).
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

1. `/` → **I'm a student** → pick **Ava Chen** → **On my own · Learn by myself**.
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
2. Class setup: paste **Class A** from "Copy-paste: teacher class instructions" above (goals,
   content, how to teach); **Simulated students: 6** → **Start class session**.
3. (Optional) In the left window Priya Patel (or Ava, back on the entry page) clicks **Wait for my teacher** before the start: she is pulled
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
| Everything stuck | `pnpm dev:voice -- --clear` resets the database, then `node scripts/seed-demo.mjs` |

## What to have open for questions

- [ARCHITECTURE.md](ARCHITECTURE.md) sections 1 (data path), 4 (voice turn diagram), 9 (classroom),
  11 (why SpacetimeDB-idiomatic).
- Debug panel in the session (hide with `?debug=0`): per-turn latency table from `turn_metrics`.
- `spacetime logs --server local voice-tutor` for live procedure logs (LLM latency and tokens per call).
