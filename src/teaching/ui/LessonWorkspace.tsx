import { useReducedMotion } from "motion/react";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { MathStudio } from "../../presentation/math/MathStudio";
import { TeachingCanvas } from "../../presentation/TeachingCanvas";
import { TeachingSession } from "../TeachingSession";
import type { TeachingPhase, LearnerResponse } from "../contracts";
import { createStreamingPlanningModel } from "../modelAdapter";
import { demoPlanningModel, demoTopics } from "../dev/demoModel";
import { SlantLesson } from "./SlantLesson";
import { preparedLessons, preparedPlanningModel } from "../preparedLessons";

type LessonSource = "sample" | "model" | "prepared";

const subjects = [
  { title: "Equal groups", area: "Multiplication", detail: "Why multiplying is more than adding two numbers.", kind: "groups" },
  { title: "Comparing decimals", area: "Decimals", detail: "Why more digits don't always mean a larger number.", kind: "line" },
  { title: "Where does a puddle go?", area: "Science", detail: "Follow water as it changes and moves around us.", kind: "cycle" },
];
const phaseLabels: Record<TeachingPhase, string> = {
  diagnose: "What do you think?", intuition: "Use the picture", formalize: "Write it in math",
  worked_example: "An example", repair: "Try this", solo: "Your turn",
  transfer: "A new example", return_to_problem: "Your original question",
};
function Sketch({ kind }: { kind: string }) {
  return <svg viewBox="0 0 260 110" aria-hidden="true" className="lesson-sketch">
    {kind === "groups" ? <>{[0,1,2].flatMap(r => [0,1,2,3].map(c => <rect key={`${r}-${c}`} x={63+c*35} y={17+r*28} width="20" height="18" rx="2" fill={c < 2 ? "#24594b" : "#b8723f"} />))}</>
      : kind === "fractions" ? <>{[2, 4].map((parts, row) => <g key={parts}>{Array.from({ length: parts }, (_, i) => <rect key={i} x={30 + i * 200 / parts} y={16 + row * 48} width={200 / parts} height="28" fill={i < parts / 2 ? "#d3e2d9" : "#fffefa"} stroke="#24594b" />)}</g>)}</>
      : kind === "area" ? <><path d="M30 90h140l50-70H80z" fill="#d3e2d9" stroke="#24594b" strokeWidth="2" /><path d="M30 90h50V20z" fill="#efddcc" stroke="#b8723f" strokeWidth="2" strokeDasharray="4 3" /></>
      : kind === "line" ? <><path d="M25 72H235 M50 64v16 M130 64v16 M210 64v16" fill="none" stroke="currentColor" strokeWidth="1.5" /><circle cx="104" cy="72" r="7" fill="#b8723f" /><circle cx="160" cy="72" r="7" fill="#24594b" /><path d="M104 55V34 M160 55V22" stroke="currentColor" strokeDasharray="2 3" /><text x="50" y="100" textAnchor="middle">0</text><text x="210" y="100" textAnchor="middle">1</text></>
      : <><circle cx="60" cy="43" r="16" fill="none" stroke="#b8723f" strokeWidth="2" /><path d="M52 86q28-18 56 0t56 0 M111 40q15-28 36-8q22-16 30 9q19 22-7 24h-48q-26-4-11-25" fill="none" stroke="#24594b" strokeWidth="2" /><path d="M190 72l-5 12 M207 72l-5 12 M32 74V50m-5 5 5-5 5 5" fill="none" stroke="#657e9e" strokeWidth="2" /></>}
  </svg>;
}

export function LessonWorkspace() {
  const [studio, setStudio] = useState(false);
  const [slant, setSlant] = useState(false);
  const [session, setSession] = useState<TeachingSession | null>(null);
  const [source, setSource] = useState<LessonSource>("sample");
  const [age, setAge] = useState(9);
  const [topic, setTopic] = useState("");
  const [homework, setHomework] = useState("");
  const [endpoint, setEndpoint] = useState("/api/teaching/plan");
  const [setupError, setSetupError] = useState("");
  const [bridge, setBridge] = useState("Checking connection…");
  useEffect(() => {
    const controller = new AbortController();
    void fetch("/api/teaching/status", { signal: controller.signal })
      .then(async response => { if (!response.ok) throw new Error(); return response.json(); })
      .then(status => { if (!controller.signal.aborted) setBridge(!status.configured ? "Add ANTHROPIC_API_KEY to the server settings to connect." : `Connected to ${status.model ?? "the planning model"}`); })
      .catch(() => { if (!controller.signal.aborted) setBridge("Start npm run dev to connect the local model bridge."); });
    return () => controller.abort();
  }, []);
  useEffect(() => () => session?.cancel(), [session]);
  function start(index?: number) {
    try {
      const fixture = index === undefined ? null : demoTopics[index];
      const next = new TeachingSession({
        sessionId: crypto.randomUUID(), age, ...(!fixture ? { lessonStyle: "mini_lesson" } : {}),
        topic: fixture?.label ?? topic.trim(), originalQuestion: fixture?.homework ?? homework.trim(),
      }, fixture ? demoPlanningModel : createStreamingPlanningModel(endpoint));
      session?.cancel();
      setSource(fixture ? "sample" : "model");
      setSession(next);
      window.scrollTo?.({ top: 0 });
      setSetupError("");
      void next.plan();
    } catch { setSetupError("Add a topic or question before starting."); }
  }
  function startPrepared(id: string) {
    const lesson = preparedLessons.find(item => item.id === id)!;
    const next = new TeachingSession({ sessionId: crypto.randomUUID(), age, topic: lesson.topic, lessonStyle: "mini_lesson" }, preparedPlanningModel);
    session?.cancel(); setSession(next); window.scrollTo?.({ top: 0 }); setSource("prepared"); setSetupError("");
    void next.plan();
  }
  return <section className="lesson-workspace" aria-label="Learning session">
    {slant ? <SlantLesson onExit={() => setSlant(false)} /> : studio ? <MathStudio onExit={() => setStudio(false)} /> : session ? <Lesson key={session.planner.getSnapshot().config.sessionId} session={session} source={source} onExit={() => { session.cancel(); setSession(null); }} />
      : <div className="lesson-welcome">
        <div className="lesson-intro"><span className="lesson-eyebrow">SEE IT. UNDERSTAND IT. TRY IT.</span><h1>What are you <br />wondering about?</h1><p>A little lesson. A moving picture. Then a turn for you.</p></div>
        <form className="lesson-topic-entry" onSubmit={e => { e.preventDefault(); start(); }}>
          <label htmlFor="topic-question">What would you like to understand?</label>
          <div className="lesson-topic-row"><input id="topic-question" required maxLength={1200} value={topic} onChange={e => setTopic(e.target.value)} placeholder="Why does a bigger rectangle have more area?" /><button className="lesson-primary" type="submit">Start <span aria-hidden="true">→</span></button></div>
          <small>Questions and answers are sent to your configured AI provider.</small>
          <details className="lesson-model-setup"><summary>Homework and settings</summary>
            <p className="lesson-connection" role="status">{bridge}</p>
            <label>Your original homework question (optional)<input maxLength={2000} value={homework} onChange={e => setHomework(e.target.value)} /></label>
            <label>Learner age<select value={age} onChange={e => setAge(Number(e.target.value))}>{Array.from({ length: 14 }, (_, i) => i + 5).map(value => <option key={value} value={value}>{value} years</option>)}</select></label>
            <label>Planning endpoint<input required value={endpoint} onChange={e => setEndpoint(e.target.value)} /></label>
          </details>
          {setupError && <p role="alert">{setupError}</p>}
        </form>
        <div className="lesson-samples-heading"><h2>One minute to see it differently</h2><span>Prepared lessons · start instantly</span></div>
        <div className="lesson-prepared" aria-label="Prepared visual lessons">
          {preparedLessons.map((lesson, index) => <button type="button" key={lesson.id} onClick={() => startPrepared(lesson.id)} className="lesson-prepared-item">
            <span className="lesson-prepared-index">0{index + 1}</span>
            <Sketch kind={lesson.id === "multiplication" ? "groups" : lesson.id} />
            <span className="lesson-prepared-copy"><strong>{lesson.title}</strong><span>{lesson.description}</span><small>Watch the idea unfold <span aria-hidden="true">→</span></small></span>
          </button>)}
        </div>
        <button type="button" className="slant-feature" onClick={() => setSlant(true)}>
          <svg viewBox="0 0 240 110" aria-hidden="true"><path d="M20 90h120l60-70H80z" fill="#d3e2d9" stroke="#24594b" strokeWidth="2.5" /><path d="M20 90h60V20z" fill="#efddcc" stroke="#b8723f" strokeWidth="2.5" strokeDasharray="5 4" /><path d="M150 90h50V20" fill="none" stroke="#b8723f" strokeWidth="2" strokeDasharray="3 5" /><path d="M95 8q40-14 80 0" fill="none" stroke="#b8723f" strokeWidth="1.5" markerEnd="url(#slant-arrow)" /><defs><marker id="slant-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0 0l10 5-10 5z" fill="#b8723f" /></marker></defs></svg>
          <span><span className="lesson-eyebrow">PREDICT · DRAG · PROVE</span><h2>Does slanting a shape make it bigger?</h2><p>Make a guess, slant a rectangle, then cut and slide a piece to see what really happens.</p></span>
          <span className="lesson-card-link">Start <span aria-hidden="true">→</span></span>
        </button>
        <div className="studio-invitation"><div><h2>Try the pictures</h2><p>Change shapes, split groups, or compare fractions.</p></div><button type="button" className="lesson-primary" onClick={() => setStudio(true)}>Open math studio →</button></div>
        <div className="lesson-samples-heading"><h2>Try a sample lesson</h2><span>Works offline</span></div>
        <div className="lesson-catalog" aria-label="Sample lessons">
          {subjects.map((subject, i) => <button className="lesson-card" key={subject.kind} onClick={() => start(i)}>
            <span className="lesson-card-top"><span>{subject.area}</span><span>0{i + 1}</span></span>
            <Sketch kind={subject.kind} /><h2>{subject.title}</h2><p>{subject.detail}</p><span className="lesson-card-link">Start lesson <span aria-hidden="true">↗</span></span>
          </button>)}
        </div>
        <p className="lesson-sample-note">Read at your pace, replay a picture, or ask for a smaller step. Audio is not connected yet.</p>

      </div>}
  </section>;
}

export function Lesson({ session, source, onExit }: { session: TeachingSession; source: LessonSource; onExit(): void }) {
  const state = useSyncExternalStore(session.subscribe, session.getSnapshot);
  const teaching = useSyncExternalStore(session.planner.subscribe, session.planner.getSnapshot);
  const visual = useSyncExternalStore(session.director.subscribe, session.director.getSnapshot);
  const [answer, setAnswer] = useState("");
  const [paused, setPaused] = useState(false);
  const reducedMotion = useReducedMotion();
  const heading = useRef<HTMLHeadingElement>(null);
  const step = teaching.step;
  const outline = session.getLessonOutline();
  const nextReady = session.hasNextBeat();
  const presenting = teaching.status === "presenting" || (state.busy && state.beatIndex >= 0);
  const latestEvidence = teaching.evidence.at(-1);
  const waiting = teaching.status === "awaiting_response" && !state.busy;
  const complete = teaching.status === "completed";
  const check = step?.check;
  const narration = visual.beat?.narration ?? "";
  const spoken = check && narration.endsWith(check.prompt) ? narration.slice(0, -check.prompt.length).trim() : narration;
  const empty = !visual.canvas.math && !visual.canvas.activity && !visual.canvas.nodes.length;
  useEffect(() => { setAnswer(""); }, [outline?.id]);
  const duration = Math.max(2500, Math.min(15000, (1.2 + narration.split(/\s+/).filter(Boolean).length / 2.8) * 1000));
  useEffect(() => { setPaused(Boolean(reducedMotion)); }, [outline?.id, reducedMotion]);
  useEffect(() => {
    if (session.playbackMode === "voice" || paused || !presenting || !nextReady) return;
    const run = state.playbackRun, index = state.beatIndex;
    const timer = setTimeout(() => {
      const current = session.getSnapshot();
      if (current.playbackRun === run && current.beatIndex === index)
        session.presentNext();
    }, duration);
    return () => clearTimeout(timer);
  }, [session, state.beatIndex, state.playbackRun, presenting, nextReady, paused, duration]);
  const respond = (response: LearnerResponse["response"]) => {
    if (response.kind === "help" && response.request !== "repeat") window.scrollTo?.({ top: 0 });
    void session.respond(response);
  };
  return <>
    <div className="lesson-topline"><button className="lesson-back" onClick={onExit}>← All topics</button><span>{source === "sample" ? "Offline sample" : source === "prepared" ? "Prepared lesson · works offline" : "Live AI lesson"}</span></div>
    <div className="lesson-title"><h1>{teaching.config.topic}</h1>{outline && <p>{outline.learningGoal}</p>}</div>
    {source !== "sample" && <ol className="lesson-journey" aria-label="Lesson journey"><li aria-current={!waiting && !complete ? "step" : undefined}>1 <span>See the idea</span></li><li aria-current={waiting ? "step" : undefined}>2 <span>Try it yourself</span></li><li aria-current={complete ? "step" : undefined}>3 <span>Take it with you</span></li></ol>}
    <div className="lesson-stage">
      <div className="lesson-paper">
        {narration && <h2 ref={heading} tabIndex={-1} className="lesson-narration lesson-caption">{spoken || check?.prompt || narration}</h2>}
        {empty ? <section className="lesson-think" aria-label="Thinking space"><span className="lesson-eyebrow">{complete ? "YOUR QUESTION" : "PICTURE"}</span><h2>{complete ? teaching.config.originalQuestion || "Where could you use this idea?" : step ? visual.canvas.title : "Your picture will appear here"}</h2><div className="lesson-pencil-rule" /><p>{complete ? "Try it yourself. Use the ideas you explored here to explain your thinking." : ""}</p></section>
          : <TeachingCanvas key={state.playbackRun} canvas={visual.canvas} interactionEnabled={session.canInteract()} onMathAction={session.interactMath} onActivityAction={session.interactActivity} />}
        {outline && outline.beatCount > 1 && state.beatIndex >= 0 && <div className="lesson-playback" aria-label="Explanation playback">
          <div className="lesson-filmstrip" aria-label={`Part ${state.beatIndex + 1} of ${outline.beatCount}`}>
            {Array.from({ length: outline.beatCount }, (_, index) => <span key={index} className={index <= state.beatIndex ? "seen" : ""} aria-current={index === state.beatIndex ? "step" : undefined} />)}
          </div>
          <span>{state.beatIndex + 1} / {outline.beatCount}{state.busy && !nextReady && <span className="lesson-more" role="status" aria-label="More coming"> …</span>}</span>
          {presenting && session.playbackMode === "text" && <>
            <button type="button" onClick={() => setPaused(p => !p)}>{paused ? "Play" : "Pause"}</button>
            <button type="button" disabled={!nextReady} onClick={session.presentNext}>Next</button>
            <button type="button" disabled={!nextReady} onClick={session.skipToEnd}>Skip to question</button>
          </>}
          <button type="button" disabled={state.busy || !["presenting", "awaiting_response"].includes(teaching.status)} title="Replay from the beginning and reset changes to this picture" onClick={() => { setPaused(Boolean(reducedMotion)); session.replay(); }}>Replay</button>
        </div>}
        {!complete && teaching.config.originalQuestion && <div className="lesson-saved-question"><span>Saved for you</span><p>{teaching.config.originalQuestion}</p><small>We'll practice on other examples first.</small></div>}
      </div>
      <aside className="lesson-conversation" aria-label="Tutor conversation">
        <div className="lesson-turn-label"><span className="lesson-tutor-mark" aria-hidden="true">↗</span><span>{outline ? phaseLabels[outline.phase] : "Let's begin"}</span><span className="lesson-turn-number">{String(teaching.history.length || 1).padStart(2, "0")}</span></div>

        {presenting && source !== "sample" && <div className="lesson-guide"><h2>{latestEvidence?.outcome === "incorrect" ? "Not quite — let’s look again." : latestEvidence?.response.kind === "help" ? "Let’s make it click." : "Watch the picture."}</h2><p>{latestEvidence?.outcome === "incorrect" ? "We’ll build the idea another way, then you can try again." : "First we’ll build the idea together. Your turn comes after the explanation."}</p><div className="lesson-help"><span>You can stop me anytime</span><div><button type="button" disabled={state.busy && teaching.status !== "presenting"} onClick={() => respond({ kind: "help", request: "simpler" })}>Smaller steps</button><button type="button" disabled={state.busy && teaching.status !== "presenting"} onClick={() => respond({ kind: "help", request: "another_way" })}>Another picture</button></div></div></div>}
        {state.busy && latestEvidence && <p className="lesson-feedback" role="status">{latestEvidence.outcome === "correct" ? "That’s right. Let’s try a new example." : latestEvidence.outcome === "incorrect" ? "Not quite yet. Let’s look at why together." : latestEvidence.response.kind === "help" ? "Let’s give that idea a little more room." : "Let’s look at your thinking together."}</p>}

        {waiting && check && <form className="lesson-response" onSubmit={e => { e.preventDefault(); if (answer.trim()) respond({ kind: "answer", text: answer.trim() }); }}>
          {spoken && <p className="lesson-question">{check.prompt}</p>}
          {check.kind === "choice" ? <div className="lesson-choices">{check.options.map((option, i) => <button key={option.id} type="button" onClick={() => respond({ kind: "choice", optionId: option.id })}><span aria-hidden="true">{String.fromCharCode(65+i)}</span>{option.label}<span aria-hidden="true">↗</span></button>)}</div>
            : ["math_value", "placement", "order"].includes(check.kind) ? <><p className="lesson-response-hint">When you are ready, check your picture.</p><button className="lesson-primary" type="button" onClick={() => respond({ kind: "interaction" })}>Check my picture →</button></>
              : <><label htmlFor="lesson-answer">Your thinking</label><div className="lesson-answer-row"><input id="lesson-answer" autoComplete="off" maxLength={2000} value={answer} onChange={e => setAnswer(e.target.value)} placeholder={check.kind === "number" ? "Your answer…" : "What do you think?"} /><button className="lesson-primary" type="submit" disabled={!answer.trim()} aria-label="Send answer">→</button></div></>}
          <div className="lesson-help"><span>Need a different approach?</span><div>{source === "model" && <button type="button" onClick={() => respond({ kind: "help", request: "explain" })}>Show me</button>}<button type="button" onClick={() => respond({ kind: "help", request: "another_way" })}>Show another way</button><button type="button" onClick={() => respond({ kind: "help", request: "simpler" })}>Smaller step</button><button type="button" onClick={() => respond({ kind: "help", request: "repeat" })}>Repeat</button></div></div>
        </form>}
        {state.busy ? <div className="lesson-planning" role="status"><span>{presenting ? "The rest of your lesson is arriving…" : latestEvidence?.outcome === "incorrect" ? "Preparing another explanation…" : "Building your visual lesson…"}</span><button onClick={session.cancel}>Cancel</button></div>
          : teaching.status === "needs_plan" && <button className="lesson-primary" onClick={() => void session.plan()}>{state.error ? "Try again" : "Continue"} <span aria-hidden="true">→</span></button>}
        {complete && <div className="lesson-finish"><p>{teaching.config.originalQuestion ? "Now try your original question without help." : "Try explaining how you would solve another example."}</p><button className="lesson-primary" onClick={onExit}>Another question →</button></div>}
        {state.error && <div className="lesson-error" role="alert"><strong>This step couldn't load.</strong><p>Your picture is still here. Try again, or choose another topic.</p><details><summary>Technical details</summary><p>{state.error}</p></details></div>}
      </aside>
    </div>
    {teaching.history.length > 0 && <details className="lesson-notebook"><summary>Your lesson notes <span>{teaching.history.length} {teaching.history.length === 1 ? "step" : "steps"}</span></summary><ol>{teaching.history.map((item, i) => {
      const evidence = teaching.evidence.filter(e => e.stepId === item.id).at(-1);
      return <li key={item.id}><span className="lesson-note-index">{String(i+1).padStart(2,"0")}</span><div><h3>{phaseLabels[item.phase]}</h3>{item.beats.map(beat => <p key={beat.id}>{beat.narration}</p>)}{evidence && <small>{evidence.response.kind === "help" ? "You asked for a different approach." : evidence.source === "model_tentative" ? "Explanation discussed; not scored." : evidence.outcome === "correct" ? "Correct answer." : evidence.outcome === "incorrect" ? "We revisited this idea." : "We needed more detail."}</small>}</div></li>;
    })}</ol></details>}
  </>;
}
