# Devpost draft

Copy-paste text for the Devpost submission. Every number is from a local test on one laptop; the
source is given in brackets so the team can check it before submitting. Remove the bracketed
sources when pasting if Devpost formatting needs it.

---

## Title

Voice math tutor on SpacetimeDB

## Tagline

A voice tutor that helps kids aged 8–12 understand their fractions homework with pictures that
move as it speaks, plus a live classroom view for teachers.

## Inspiration

Children between 8 and 12 often get stuck on homework because they miss the idea, not the
arithmetic: they add the tops and the bottoms of fractions because nobody showed them what a
quarter looks like. When no adult at home can explain it, help usually means the answer, which
skips the understanding. Teachers with 25 students can't see who is stuck on what until the test.

> TODO (team): add a real quote from a parent, teacher or tutor, with permission. Do not invent one.

## What it does

A child picks "Learn by myself", types or photographs the task and starts talking. The tutor
answers by voice and explains with a picture on a canvas that changes on the exact word it is
saying. It follows the order teachers use: an intuitive picture first, then the notation, then a
similar task with different numbers that the child solves alone. A wrong or unsure answer gets one
smaller step. At the end the child gets their own homework back. The tutor doesn't solve it for
them. The child can interrupt the tutor mid-sentence. Notes about what the child mixes up shape the
next lesson.

Teachers set the learning goal and how they want the topic taught, then start a class: every
online student joins. A dashboard shows a class summary and groups of students who are stuck the
same way, refreshed every 30 seconds. The teacher can hover a student and watch their screen live.
For the demo, Claude plays up to 20 simulated students with typical misconceptions, who talk to the
real tutor.

**Cartesia.** Cartesia is how the tutor hears and speaks. Each phrase the child says is transcribed
with Ink (`ink-whisper` over the batch API; `ink-2` through a small proxy) while the child is still
talking. Each sentence of the reply is spoken with Sonic (`sonic-3.6`) in the voice "Parker", and
Sonic's word timestamps decide when each part of the picture appears. Measured end of speech → first
tutor audio: p50 2.75 s [docs/NIGHT_REPORT.md, final E2E].

**SpacetimeDB.** SpacetimeDB is the entire backend. Audio goes up as reducer calls; speech-to-text,
speech synthesis, memory, simulated students and the dashboard run as scheduled procedures inside
the module; tutor audio comes back as event rows. Every screen (the child's, the teacher's
dashboard, the live observer) is a subscription to rows, so watching a student live needed no extra
code path. Every AI output goes through a reducer that checks it before the child sees it.

**Anthropic.** Claude Haiku 5.5 (`claude-haiku-5-5`, Anthropic API) plans every lesson and writes
what the tutor says, streamed moment by moment. Inside the database it also writes the private
memory notes, the session summaries, the simulated students' messages and the teacher's class
summary and groups, using structured outputs. Code checks what Claude proposes: answers are graded
deterministically, equations are computed from the picture, and a check that repeats the child's
own homework is rejected.

## How we built it

- **SpacetimeDB 2.13 TypeScript module** with public, private, event and scheduled tables. Reducers
  validate every write; procedures call Cartesia and Anthropic over HTTP.
- **A small Node worker** that only streams Claude, because a procedure's HTTP call returns the
  whole response and can't read a token stream (async procedures are proposed in
  SpacetimeDB issue #4697). It connects as a normal client; the module decides everything.
- **A static React client** (Vite) with browser voice activity detection (Silero via vad-web),
  Pipecat Smart Turn v3.2 for semantic end-of-turn, barge-in, and the team's visual engine for the
  canvas.
- **The team's teaching methodology** as a shared package: lesson contracts, a compiler that turns
  each lesson moment into canvas state, validators and deterministic answer checks.
- **End-to-end tests** that feed Cartesia-generated speech into a fake microphone in headless Chrome
  and measure every stage of a voice turn.

## Challenges we ran into

- **Streaming from a database.** Procedures can't stream, so we kept only LLM streaming in a worker
  and made the module validate each lesson moment as it arrives.
- **Latest STT model is websocket-only.** `ink-2` needs a websocket, which procedures can't open,
  and SpacetimeDB refuses HTTP to private addresses. We default to `ink-whisper` over batch and
  wrote a batch-compatible proxy for `ink-2` that has to run on a public host.
- **Latency.** Turn end → first audio went from p50 4.3 s with a tool loop to 2.5 s with the
  streaming lesson planner [README "Lesson pipeline"]. Our own overhead is about 100 ms per turn;
  the rest is silence detection, STT, the first tokens and the first sentence's audio
  [docs/latency-internal.md §2].
- **Thinking pauses.** Children say "um" and pause; early versions split one answer into two turns.
  Re-entry thresholds, an activity hold and Smart Turn fixed it in our tests.
- **Procedure slots.** A procedure waiting on HTTP holds a slot (~10 locally), so with 4 parallel
  voice sessions TTS jobs waited up to 0.7 s [docs/PITCH.md]. We cap simulated-student calls at 4.

## Accomplishments that we're proud of

- One SpacetimeDB module is the whole backend; the client is static files.
- End of speech → first tutor audio p50 2.75 s (min 2.62, max 3.17) on the final build, 8/8
  end-to-end voice runs passing [docs/NIGHT_REPORT.md].
- 0 rejected lesson moments in the end-to-end runs after the lesson pipeline merge [docs/NIGHT_REPORT.md].
- 8 simulated students held 64 turns with the real tutor in about 2 minutes [docs/CLASSROOM.md].
- Live observe of any student's screen with no extra code path: the same view on the same rows.

## What we learned

A database with subscriptions, scheduled jobs and validating reducers covers most of what a voice
agent backend needs. The parts that still need a separate process are the ones that stream.

## What's next

- Test with real children, teachers and parents, on real devices and loudspeakers.
- Move to Maincloud and measure there.
- Stream the first sentence's audio to cut latency further, and use `ink-2` once it can be reached
  directly.
- Enforce spoken length and check the narration's math in code, not only in the prompt.
- Accounts, consent and data deletion before any real use with children.
- A teacher-only student profile panel (in progress, test data only).

## Built with

SpacetimeDB · TypeScript · Node.js · React · Vite · Cartesia Sonic (`sonic-3.6`) · Cartesia Ink
(`ink-whisper`, `ink-2`) · Anthropic Claude Haiku 5.5 · @ricky0123/vad-web (Silero VAD) ·
Pipecat Smart Turn v3.2 · onnxruntime-web · Motion · Zod · Vitest · puppeteer-core (headless Chrome) · PHP (stt-proxy)

## Before submitting (team)

- [ ] Real quote in "Inspiration" (or remove the placeholder)
- [ ] Demo video link (voice, not text mode)
- [ ] Team members on Devpost
- [ ] Prize opt-ins: Cal Hacks general, Cartesia, SpacetimeDB, Anthropic "Claude for Public Benefit"
- [ ] Repo link and screenshots (`docs/screenshots/11-…`, `24-…`, `15-…`)
