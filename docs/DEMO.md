# Two-minute demo: Fibonacci

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
node scripts/seed-demo.mjs              # idempotent: creates missing users, skips existing ones, (re)writes seed memory
node scripts/seed-demo.mjs --dry-run    # show what it would do
node scripts/seed-demo.mjs --no-memory  # users only
```

Change names, ages, grades or styles in **`scripts/demo-seed.json`** and re-run the script. Users are
matched by name: a new name is added, an existing one is never changed (the script prints the
difference). To apply changes to an existing user: `node scripts/publish.mjs --clear`, then
`node scripts/seed-demo.mjs`. `SPACETIME_DB=<name>` seeds another local database.

**Seed memory.** Each student's `memory` in `demo-seed.json` (notes, mastery, one earlier session
summary + next focus) is written on every run by the agent-only reducer
`seedMemory(learnerId, memoryJson)`; the script registers the CLI identity as agent with
`AGENT_SECRET` from `.env.local` (never printed). Re-running **replaces** the seeded notes and the
seed summary of that student; notes the tutor wrote in real sessions stay, mastery is overwritten
per listed concept. So after a rehearsal `node scripts/seed-demo.mjs` puts the seeded memory back
(it does not delete the rehearsal's own notes or sessions; for a fully clean state use
`publish.mjs --clear` + seed). Seeded rows are marked by a pseudo session id (2^62 + learner id) on
their evidence and summary; check them as owner with
`spacetime sql --no-config --server local voice-tutor "SELECT * FROM memory_note"`.

### Seeded users

| Who | Age | Grade | Learning style | Demo role |
| --- | --- | --- | --- | --- |
| Ava Chen | 9 | 4 | pictures first, short hints | self-learning flow ("On my own"), fractions |
| Sam Rivera | 11 | 6 | step by step, likes to check with numbers | self-learning flow, decimals |
| Priya Patel | 8 | 3 | short sentences, lots of encouragement, pictures first | "Wait for my teacher" flow |
| Ms. Park | | | teacher | runs the class |
| Mr. Alvarez | | | teacher (spare) | second class / backup |

What the tutor remembers about them from the start (seed memory, `scripts/demo-seed.json`; shown in
the prompt once the session's topic category is known, preferences always):

| Who | Notes | Mastery | Earlier session → next focus |
| --- | --- | --- | --- |
| Ava Chen (2 days ago) | misconception: multiplied only the bottom (2/3 = 2/6) · strategy (worked): cutting each pizza slice in two · mnemonic: "what you do to the bottom, you do to the top" · understood: what the bottom number means · preference: picture first, one short hint at a time | fractions-unit 75, fractions-expand 35 | expanded 2/3 to sixths with pizza, fixed 2/6 → 4/6 herself → **expand 2/3 to twelfths** |
| Sam Rivera (3 days ago) | misconception: 0.35 > 0.4 "because 35 > 4" · strategy (worked): same number of digits (0.40 vs 0.35) · strategy (didn't): hundred grid alone · quote: "the zero at the end doesn't change anything" · preference: check with money / a second example | place-value 85, decimals-tenths 40 | 0.4 vs 0.35, fixed by padding + money → **compare 0.3 and 0.25 on his own** |
| Priya Patel (1 day ago) | misconception: 1/4 + 1/4 = 2/8 · strategy (worked): colouring a chocolate bar · understood: names 1/2, 1/3, 1/4 · quote: "the bottom tells how many pieces" · preference: short sentences, "well done" after each step | fractions-unit 60, fractions-add-same 20 | halves/quarters fine, 2/8 not fixed yet → **adding with the same denominator** (Class A) |

So Ava's lesson on `Expand 2/3 so the bottom number is 12.` and Sam's on
`Which is bigger, 0.3 or 0.25? Explain why.` continue where the "earlier session" stopped, and
Priya's class lesson (Class A) starts from her 2/8 mistake. The 20 simulated classroom students
(`shared/src/classroom/simStudents.ts`) have their own seed memory (reset to it when a class starts
with "Reset simulated students" on, the default); they never appear in the student picker.

### Simulated class from the command line (`scripts/simulate.mjs`)

Starts a class exactly like the class setup screen (the simulated students need the worker):

```bash
node scripts/simulate.mjs --preset A --n 6     # Class A/B/C below; prints the class id and
                                               #   dashboard http://127.0.0.1:5175/?class=<id>
node scripts/simulate.mjs --preset B --no-reset  # keep the simulated students' memory from earlier runs
node scripts/simulate.mjs --end                # end Ms. Park's running class
node scripts/simulate.mjs --reset-only [--n 0] # simulated students 1..n (0 = all 20) back to fresh memories
```

Options: `--teacher "Mr. Alvarez"` (created if missing; default Ms. Park), `--goals/--content/--delivery`
override the preset, `--reset` (default) / `--no-reset`, `SPACETIME_DB=<name>`. Starting a class ends
that teacher's previous one and pulls in every online real student. Use it on a rehearsal database,
not on `voice-tutor` right before the demo (it leaves sessions behind).

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
      (Their names are outside the 20 simulated seed students — avoid Mia/Leo etc. for new students,
      the dashboard summary would mix them up with the simulated Mia Hoffmann / Leo Schneider.)
- [ ] Warm-up: one short voice turn in a throwaway session (first procedure runs after a publish are
      slower; Smart Turn loads after the mic starts). Use a throwaway student (add "Test Kid" in the
      picker), not Ava/Sam/Priya: a real session gives them a newer summary than the seeded one and
      the tutor would refer to the warm-up. If it happened anyway: `node scripts/seed-demo.mjs`
      restores the seeded notes, but the newer real summary stays (only `--clear` + seed removes it).
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
3. **Start talking** (the big button in the middle of the canvas). The tutor greets her and names
   the task (authored lead-in; first audio ~1.7 s after the click in the rehearsal). The canvas stays
   on "Your picture will appear here" during the lead-in; the first picture comes ~11 s after the click.
4. Say: *"I added the tops and the bottoms and got three eighths."*
5. While it answers, point at:
   - the avatar thinking (dots) while Claude plans, then speaking with the audio;
   - pieces appearing on the canvas **at the word** the tutor says;
   - the check question at the end (choice buttons or "check my picture").
6. Answer by voice (or click a choice). Optionally interrupt the tutor mid-sentence to show barge-in.
   Optional: tap the camera button next to the controls, snap a photo of written work ("Will be sent with your next answer"), then answer: the tutor's next reply looks at the photo.

> "Everything you saw went through SpacetimeDB: audio chunks up as reducer calls, speech-to-text and
> text-to-speech run in scheduled procedures, every picture is compiled and validated by a reducer
> against the canvas the child actually sees, and audio comes back as event rows. No backend server;
> the client is static files."

### 0:55–1:45 Teacher classroom (right window)

1. `/` → **I'm a teacher** → **Ms. Park**.
2. Class setup: paste **Class A** from "Copy-paste: teacher class instructions" above (goals,
   content, how to teach); **Simulated students: 6**, leave **Reset simulated students (fresh
   memories)** checked (unchecked: they remember the previous run) → **Start class session**.
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
   **Profile** on a student card shows what the tutor knows about that student (misconceptions, what helps, mastery, past sessions).

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
- Debug panel in the session (off by default, open with `?debug=1`): per-turn latency table from `turn_metrics`.
- `spacetime logs --server local voice-tutor` for live procedure logs (LLM latency and tokens per call).
