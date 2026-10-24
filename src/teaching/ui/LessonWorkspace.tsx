import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { TeachingCanvas } from "../../presentation/TeachingCanvas";
import { TeachingSession } from "../TeachingSession";
import type { TeachingPhase, LearnerResponse } from "../contracts";
import { createHttpPlanningModel } from "../modelAdapter";
import { demoPlanningModel, demoTopics } from "../dev/demoModel";

const subjects = [
  { title: "Equal groups", area: "Multiplication", detail: "Why multiplying is more than adding two numbers.", kind: "groups" },
  { title: "Small numbers, big ideas", area: "Decimals", detail: "Why more digits don't always mean a larger number.", kind: "line" },
  { title: "Where does a puddle go?", area: "Science", detail: "Follow water as it changes and moves around us.", kind: "cycle" },
];
const phaseLabels: Record<TeachingPhase, string> = {
  diagnose: "Start with your idea", intuition: "See it another way", formalize: "Connect the idea",
  worked_example: "Work one together", repair: "Look a little closer", solo: "Your turn",
  transfer: "Try somewhere new", return_to_problem: "Take it with you",
};
function Sketch({ kind }: { kind: string }) {
  return <svg viewBox="0 0 260 110" aria-hidden="true" className="lesson-sketch">
    {kind === "groups" ? <>{[0,1,2].flatMap(r => [0,1,2,3].map(c => <rect key={`${r}-${c}`} x={63+c*35} y={17+r*28} width="20" height="18" rx="2" fill={c < 2 ? "#24594b" : "#b8723f"} />))}</>
      : kind === "line" ? <><path d="M25 72H235 M50 64v16 M130 64v16 M210 64v16" fill="none" stroke="currentColor" strokeWidth="1.5" /><circle cx="104" cy="72" r="7" fill="#b8723f" /><circle cx="160" cy="72" r="7" fill="#24594b" /><path d="M104 55V34 M160 55V22" stroke="currentColor" strokeDasharray="2 3" /><text x="50" y="100" textAnchor="middle">0</text><text x="210" y="100" textAnchor="middle">1</text></>
      : <><circle cx="60" cy="43" r="16" fill="none" stroke="#b8723f" strokeWidth="2" /><path d="M52 86q28-18 56 0t56 0 M111 40q15-28 36-8q22-16 30 9q19 22-7 24h-48q-26-4-11-25" fill="none" stroke="#24594b" strokeWidth="2" /><path d="M190 72l-5 12 M207 72l-5 12 M32 74V50m-5 5 5-5 5 5" fill="none" stroke="#657e9e" strokeWidth="2" /></>}
  </svg>;
}

export function LessonWorkspace() {
  const [session, setSession] = useState<TeachingSession | null>(null);
  const [source, setSource] = useState<"sample" | "model">("sample");
  const [topic, setTopic] = useState("");
  const [homework, setHomework] = useState("");
  const [endpoint, setEndpoint] = useState("/api/teaching/plan");
  const [setupError, setSetupError] = useState("");
  useEffect(() => () => session?.cancel(), [session]);
  function start(index?: number) {
    try {
      const fixture = index === undefined ? null : demoTopics[index];
      const next = new TeachingSession({
        sessionId: crypto.randomUUID(), age: 9,
        topic: fixture?.label ?? topic.trim(), originalQuestion: fixture?.homework ?? homework.trim(),
      }, fixture ? demoPlanningModel : createHttpPlanningModel(endpoint));
      session?.cancel();
      setSource(fixture ? "sample" : "model");
      setSession(next);
      setSetupError("");
      void next.plan();
    } catch { setSetupError("Add a topic or question before starting."); }
  }
  return <section className="lesson-workspace" aria-label="Learning session">
    {session ? <Lesson key={session.planner.getSnapshot().config.sessionId} session={session} source={source} onExit={() => { session.cancel(); setSession(null); }} />
      : <div className="lesson-welcome">
        <div className="lesson-intro"><span className="lesson-eyebrow">LOOK · TRY · UNDERSTAND</span><h1>What are you <br />wondering about?</h1><p>Build a picture. Try an idea. Find a way that clicks.</p></div>
        <div className="lesson-catalog" aria-label="Sample lessons">
          {subjects.map((subject, i) => <button className="lesson-card" key={subject.kind} onClick={() => start(i)}>
            <span className="lesson-card-top"><span>{subject.area}</span><span>0{i + 1}</span></span>
            <Sketch kind={subject.kind} /><h2>{subject.title}</h2><p>{subject.detail}</p><span className="lesson-card-link">Explore this idea <span aria-hidden="true">↗</span></span>
          </button>)}
        </div>
        <p className="lesson-sample-note">Three offline sample lessons. Read the tutor's words and respond at your own pace. Voice is not connected.</p>
        <details className="lesson-model-setup"><summary>Use your team's model for another topic</summary>
          <p>Any topic can use the same lesson workspace and supported visual tools. This requires a running planning endpoint; it does not fall back to a sample.</p>
          <form onSubmit={e => { e.preventDefault(); start(); }}>
            <label>What would you like to understand?<input required maxLength={1200} value={topic} onChange={e => setTopic(e.target.value)} placeholder="Why do shadows change during the day?" /></label>
            <label>Your original question (optional)<input maxLength={2000} value={homework} onChange={e => setHomework(e.target.value)} /></label>
            <label>Planning endpoint<input required value={endpoint} onChange={e => setEndpoint(e.target.value)} /></label>
            <button className="lesson-primary" type="submit">Start my topic <span aria-hidden="true">→</span></button>
          </form>
          {setupError && <p role="alert">{setupError}</p>}
        </details>
      </div>}
  </section>;
}

function Lesson({ session, source, onExit }: { session: TeachingSession; source: "sample" | "model"; onExit(): void }) {
  const state = useSyncExternalStore(session.subscribe, session.getSnapshot);
  const teaching = useSyncExternalStore(session.planner.subscribe, session.planner.getSnapshot);
  const visual = useSyncExternalStore(session.director.subscribe, session.director.getSnapshot);
  const [answer, setAnswer] = useState("");
  const heading = useRef<HTMLHeadingElement>(null);
  const step = teaching.step;
  const waiting = teaching.status === "awaiting_response" && !state.busy;
  const complete = teaching.status === "completed";
  const check = step?.check;
  const narration = visual.beat?.narration ?? "Let's find a starting point together.";
  const spoken = check && narration.endsWith(check.prompt) ? narration.slice(0, -check.prompt.length).trim() : narration;
  const empty = !visual.canvas.math && !visual.canvas.activity && !visual.canvas.nodes.length;
  useEffect(() => { setAnswer(""); heading.current?.focus({ preventScroll: true }); }, [step?.id, state.beatIndex]);
  const respond = (response: LearnerResponse["response"]) => { void session.respond(response); };
  return <>
    <div className="lesson-topline"><button className="lesson-back" onClick={onExit}>← All topics</button><span>{source === "sample" ? "Offline sample" : "Model endpoint"} · Text mode</span></div>
    <div className="lesson-title"><h1>{teaching.config.topic}</h1><p>One idea at a time. You set the pace.</p></div>
    <div className="lesson-stage">
      <div className="lesson-paper">
        {empty ? <section className="lesson-think" aria-label="Thinking space"><span className="lesson-eyebrow">{complete ? "BACK TO YOUR QUESTION" : "A MOMENT TO THINK"}</span><h2>{complete ? teaching.config.originalQuestion || "Where could you use this idea?" : visual.canvas.title}</h2><div className="lesson-pencil-rule" /><p>{complete ? "Try it yourself. Use the ideas you explored here to explain your thinking." : "Start with what you think. We'll build the picture together."}</p></section>
          : <TeachingCanvas canvas={visual.canvas} interactionEnabled={session.canInteract()} onMathAction={session.interactMath} onActivityAction={session.interactActivity} />}
        {!complete && teaching.config.originalQuestion && <div className="lesson-saved-question"><span>Saved for you</span><p>{teaching.config.originalQuestion}</p><small>We'll practice on other examples first.</small></div>}
      </div>
      <aside className="lesson-conversation" aria-label="Tutor conversation">
        <div className="lesson-turn-label"><span className="lesson-tutor-mark" aria-hidden="true">↗</span><span>{step ? phaseLabels[step.phase] : "Let's begin"}</span><span className="lesson-turn-number">{String(teaching.history.length || 1).padStart(2, "0")}</span></div>
        <h2 ref={heading} tabIndex={-1} className="lesson-narration">{spoken}</h2>
        {waiting && check && <form className="lesson-response" onSubmit={e => { e.preventDefault(); if (answer.trim()) respond({ kind: "answer", text: answer.trim() }); }}>
          <p className="lesson-question">{check.prompt}</p>
          {check.kind === "choice" ? <div className="lesson-choices">{check.options.map((option, i) => <button key={option.id} type="button" onClick={() => respond({ kind: "choice", optionId: option.id })}><span aria-hidden="true">{String.fromCharCode(65+i)}</span>{option.label}<span aria-hidden="true">↗</span></button>)}</div>
            : ["math_value", "placement", "order"].includes(check.kind) ? <><p className="lesson-response-hint">Make your changes in the picture, then share your answer.</p><button className="lesson-primary" type="button" onClick={() => respond({ kind: "interaction" })}>Check my picture →</button></>
              : <><label htmlFor="lesson-answer">Your thinking</label><div className="lesson-answer-row"><input id="lesson-answer" autoComplete="off" maxLength={2000} value={answer} onChange={e => setAnswer(e.target.value)} placeholder={check.kind === "number" ? "A number, or write it in words…" : "Tell me how you see it…"} /><button className="lesson-primary" type="submit" disabled={!answer.trim()} aria-label="Send answer">→</button></div></>}
          <div className="lesson-help"><span>Need a different approach?</span><div><button type="button" onClick={() => respond({ kind: "help", request: "another_way" })}>Show another way</button><button type="button" onClick={() => respond({ kind: "help", request: "simpler" })}>Smaller step</button><button type="button" onClick={() => respond({ kind: "help", request: "repeat" })}>Repeat</button></div></div>
        </form>}
        {state.busy ? <div className="lesson-planning" role="status"><span>Preparing the next picture…</span><button onClick={session.cancel}>Cancel</button></div>
          : teaching.status === "presenting" ? <button className="lesson-primary" onClick={session.presentNext}>Continue <span aria-hidden="true">→</span></button>
          : teaching.status === "needs_plan" && <button className="lesson-primary" onClick={() => void session.plan()}>{state.error ? "Try again" : "Continue"} <span aria-hidden="true">→</span></button>}
        {complete && <div className="lesson-finish"><p>You tried {session.planner.recap().independentChecksPassed.length} independent examples successfully. Your original question is ready for you.</p><button className="lesson-primary" onClick={onExit}>Explore another idea →</button></div>}
        {state.error && <div className="lesson-error" role="alert"><strong>This step couldn't load.</strong><p>{state.error}</p></div>}
        <p className="lesson-voice-note">Read, explore, respond. No microphone needed.</p>
      </aside>
    </div>
    {teaching.history.length > 0 && <details className="lesson-notebook"><summary>Your lesson notes <span>{teaching.history.length} {teaching.history.length === 1 ? "step" : "steps"}</span></summary><ol>{teaching.history.map((item, i) => {
      const evidence = teaching.evidence.filter(e => e.stepId === item.id).at(-1);
      return <li key={item.id}><span className="lesson-note-index">{String(i+1).padStart(2,"0")}</span><div><h3>{phaseLabels[item.phase]}</h3>{item.beats.map(beat => <p key={beat.id}>{beat.narration}</p>)}{evidence && <small>{evidence.response.kind === "help" ? "You asked for a different approach." : evidence.source === "model_tentative" ? "Tutor interpretation — still tentative." : evidence.outcome === "correct" ? "Your answer matched the check." : evidence.outcome === "incorrect" ? "We revisited this idea." : "We needed more detail."}</small>}</div></li>;
    })}</ol></details>}
  </>;
}
