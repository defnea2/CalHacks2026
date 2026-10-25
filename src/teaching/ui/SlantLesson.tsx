import { useEffect, useReducer, useRef, useState, useSyncExternalStore } from "react";
import { ShearProof } from "../../presentation/math/ShearProof";
import {
  areaRevealed, canCut, canDrag, createShearLesson, reduceShearLesson, shapeArea,
  type AreaPrediction, type ShearLesson,
} from "../../visual-math/shear";
import { ShearTutorConversation } from "../shearTutor";

const predictions: { id: AreaPrediction; label: string }[] = [
  { id: "bigger", label: "It gets bigger" }, { id: "smaller", label: "It gets smaller" }, { id: "same", label: "It stays the same" },
];
const predicted = { bigger: "bigger", smaller: "smaller", same: "the same" } as const;
const stage = { prediction: "slant", exploration: "slant", cut: "cut", translation: "reassembled", explanation: "reassembled" } as const;

export function SlantLesson({ onExit, conversation: provided }: { onExit(): void; conversation?: ShearTutorConversation }) {
  const [lesson, dispatch] = useReducer(reduceShearLesson, undefined, () => createShearLesson());
  const [conversation] = useState(() => provided ?? new ShearTutorConversation());
  const tutor = useSyncExternalStore(conversation.subscribe, conversation.getSnapshot);
  const current = useRef<ShearLesson>(lesson); current.current = lesson;
  const [answer, setAnswer] = useState("");
  const { phase, shape, prediction } = lesson;

  // Ask the tutor once per attempt, right after the learner has seen the proof for the first time.
  const asked = useRef(0);
  useEffect(() => {
    if (phase !== "explanation" || asked.current === lesson.attempts || tutor.messages.some(m => m.role === "learner")) return;
    asked.current = lesson.attempts;
    void conversation.send(lesson, "reveal", null, () => current.current);
  }, [phase, lesson.attempts]);
  useEffect(() => () => conversation.cancel(), [conversation]);

  const learnerTurns = tutor.messages.filter(m => m.role === "learner").length;
  const submit = () => {
    const text = answer.trim();
    if (!text || tutor.pending) return;
    setAnswer("");
    void conversation.send(lesson, learnerTurns === 0 ? "explanation" : "transfer", text, () => current.current);
  };
  const restart = (type: "try_again" | "reset") => {
    conversation.cancel();
    if (type === "reset") { conversation.reset(); asked.current = 0; }
    dispatch({ type });
  };
  const offline = tutor.messages.some(m => m.source === "offline");

  return <div className="slant-lesson">
    <div className="lesson-topline"><button className="lesson-back" onClick={() => { conversation.cancel(); onExit(); }}>← All topics</button><span>Geometry · The picture works offline</span></div>
    <div className="lesson-title"><h1>Does slanting a shape make it bigger?</h1></div>
    <div className="lesson-stage">
      <div className="lesson-paper">
        <ShearProof shape={shape} stage={stage[phase]} draggable={canDrag(lesson)} showOriginal={phase !== "prediction"}
          caption={phase === "prediction" ? "A rectangle. What happens to its area if we slant it?" : undefined}
          onShear={shear => dispatch({ type: "set_shear", shear })} animate={phase === "translation"}
          onSettled={() => dispatch({ type: "settled" })} showArea={areaRevealed(lesson)} />
        {phase !== "prediction" && <fieldset className="math-controls slant-controls" disabled={!canDrag(lesson)}>
          <legend>Drag the top edge, or use the slider</legend>
          <label>Slant<input aria-label="Slant" type="range" min="0" max={shape.base} step="0.5" value={shape.shear}
            onChange={e => dispatch({ type: "set_shear", shear: Number(e.target.value) })} /><output>{shape.shear}</output></label>
        </fieldset>}
      </div>
      <aside className="lesson-conversation" aria-label="Tutor conversation">
        <div className="lesson-turn-label"><span className="lesson-tutor-mark" aria-hidden="true">↗</span><span>{{ prediction: "What do you think?", exploration: "Use the picture", cut: "Cut it", translation: "Watch", explanation: "What happened?" }[phase]}</span></div>
        {phase === "prediction" && <div className="lesson-response">
          <p className="lesson-question">Here is a rectangle. If we slant it sideways but keep the same base and the same height, what happens to its area?</p>
          <div className="lesson-choices">{predictions.map((p, i) => <button key={p.id} type="button" onClick={() => dispatch({ type: "predict", prediction: p.id })}><span aria-hidden="true">{String.fromCharCode(65 + i)}</span>{p.label}<span aria-hidden="true">↗</span></button>)}</div>
        </div>}
        {prediction && <p className="slant-prediction">You predicted the area would be <strong>{predicted[prediction]}</strong>.</p>}
        {phase === "exploration" && <div className="lesson-response">
          <p className="lesson-question">{shape.shear === 0 ? "Drag the dark handle on the top edge to the right. Try a big slant!" : "Look: the base is still " + shape.base + " and the height is still " + shape.height + ". Let's test your prediction by cutting the shape."}</p>
          <button className="lesson-primary" type="button" disabled={!canCut(lesson)} onClick={() => dispatch({ type: "cut" })}>Cut along the height <span aria-hidden="true">✂</span></button>
          {!canCut(lesson) && <p className="lesson-response-hint">Slant the shape first. A rectangle has no extra piece to cut.</p>}
        </div>}
        {phase === "cut" && <div className="lesson-response">
          <p className="lesson-question">The amber triangle is the part that sticks out. We will move that exact piece, without stretching it.</p>
          <button className="lesson-primary" type="button" onClick={() => dispatch({ type: "slide" })}>Slide it across <span aria-hidden="true">→</span></button>
        </div>}
        {phase === "translation" && <p className="lesson-response-hint" role="status">Watch where the triangle lands…</p>}
        {areaRevealed(lesson) && <>
          <div className="slant-reveal" role="status">
            <div><span>Rectangle at the start</span><strong>{shapeArea(shape)}</strong></div>
            <div><span>Slanted shape</span><strong>{shapeArea(shape)}</strong></div>
            <p>square units: {shape.base} × {shape.height} both times. {prediction === "same" ? "Your prediction matched." : "Not what you predicted, and that's worth figuring out."}</p>
          </div>
          <ol className="slant-messages" aria-label="Conversation" aria-live="polite">
            {tutor.messages.map((m, i) => <li key={i} className={`slant-message is-${m.role}`}>
              {m.role === "tutor" && <span className="slant-source">{m.source === "offline" ? "Offline tutor · scripted, not live" : "Tutor"}</span>}
              <p>{m.text}</p>
            </li>)}
          </ol>
          {tutor.pending ? <div className="lesson-planning" role="status"><span>The tutor is reading your work…</span><button onClick={conversation.cancel}>Cancel</button></div>
            : tutor.messages.length > 0 && <form className="lesson-response" onSubmit={e => { e.preventDefault(); submit(); }}>
              <label htmlFor="slant-answer">Your thinking</label>
              <div className="lesson-answer-row"><input id="slant-answer" autoComplete="off" maxLength={600} value={answer} onChange={e => setAnswer(e.target.value)} placeholder={learnerTurns === 0 ? "Why did the area stay the same?" : "Your answer…"} /><button className="lesson-primary" type="submit" disabled={!answer.trim()} aria-label="Send answer">→</button></div>
            </form>}
          {offline && tutor.error && <details className="slant-offline"><summary>Why is the tutor offline?</summary><p>{tutor.error}</p></details>}
          <div className="lesson-help"><span>Explore more</span><div>
            <button type="button" disabled={Boolean(tutor.pending)} onClick={() => dispatch({ type: "replay" })}>Replay the proof</button>
            <button type="button" onClick={() => restart("try_again")}>Try a different slant</button>
            <button type="button" onClick={() => restart("reset")}>Start over</button>
          </div></div>
        </>}
      </aside>
    </div>
  </div>;
}
