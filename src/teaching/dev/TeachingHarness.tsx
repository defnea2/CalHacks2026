import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { TeachingCanvas } from "../../presentation/TeachingCanvas";
import { VisualDirector } from "../../presentation/VisualDirector";
import { TeachingPlanner, type PlanningRequest } from "../TeachingPlanner";
import { createHttpPlanningModel } from "../modelAdapter";
import type { LearnerResponse, TeachingStep } from "../contracts";
import { demoPlanningModel, demoTopics } from "./demoModel";
import "./teaching.css";

export function TeachingHarness() {
  const [topic, setTopic] = useState<string>(demoTopics[0].label);
  const [homework, setHomework] = useState<string>(demoTopics[0].homework);
  const [planner, setPlanner] = useState(
    () =>
      new TeachingPlanner({
        sessionId: crypto.randomUUID(),
        topic,
        originalQuestion: homework,
      }),
  );
  const [director] = useState(() => new VisualDirector());
  const teaching = useSyncExternalStore(planner.subscribe, planner.getSnapshot);
  const visual = useSyncExternalStore(director.subscribe, director.getSnapshot);
  const [mode, setMode] = useState("demo");
  const [endpoint, setEndpoint] = useState("/api/teaching/plan");
  const [answer, setAnswer] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [beatIndex, setBeatIndex] = useState(0);
  const [lastRequest, setLastRequest] = useState<PlanningRequest | null>(null);
  const [changes, setChanges] = useState(0);
  const abort = useRef<AbortController | null>(null);
  useEffect(() => () => abort.current?.abort(), []);
  const run = (work: () => void) => {
    try {
      work();
      setError("");
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Could not apply the operation.",
      );
    }
  };
  const playBeat = (step: TeachingStep, index: number) => {
    const token = director.prepare(step.beats[index]);
    director.narrationStarted(token);
    director.narrationEnded(token);
    setBeatIndex(index);
    if (index === step.beats.length - 1) planner.presented(step.id);
  };
  const plan = async () => {
    const controller = new AbortController();
    abort.current?.abort();
    abort.current = controller;
    setBusy(true);
    setError("");
    try {
      const model =
        mode === "demo" ? demoPlanningModel : createHttpPlanningModel(endpoint);
      const step = await planner.generate(
        async (request, signal) => {
          setLastRequest(request);
          return model(request, signal);
        },
        director.getSnapshot().canvas,
        () => director.getSnapshot().canvas,
        controller.signal,
      );
      if (!controller.signal.aborted) playBeat(step, 0);
    } catch (e) {
      if (!controller.signal.aborted)
        setError(e instanceof Error ? e.message : "Planning failed.");
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  };
  const respond = (response: LearnerResponse["response"]) =>
    run(() => {
      if (!teaching.step) return;
      planner.respond(
        { eventId: crypto.randomUUID(), stepId: teaching.step.id, response },
        director.getSnapshot().canvas,
      );
      setAnswer("");
    });
  const waiting = teaching.status === "awaiting_response";
  const check = teaching.step?.check;
  const latest = teaching.evidence.at(-1);
  return (
    <main className="teaching-harness">
      <header>
        <span className="teaching-kicker">
          MEMBER 3 · INDEPENDENT DEVELOPMENT
        </span>
        <h1>
          Teach the idea.
          <br />
          <em>Follow the understanding.</em>
        </h1>
        <p>
          A teaching planner that directs the shared canvas, checks responses,
          and adapts its next step.
        </p>
      </header>
      <section className="teaching-setup" aria-label="Lesson setup">
        <label>
          Try a fixture
          <select
            aria-label="Fixture topic"
            onChange={(e) => {
              const item = demoTopics.find((x) => x.id === e.target.value)!;
              setTopic(item.label);
              setHomework(item.homework);
            }}
          >
            <option value="multiplication">Equal groups</option>
            <option value="decimals">Decimal comparison</option>
            <option value="water">Water cycle</option>
          </select>
        </label>
        <label className="teaching-topic">
          Topic or conceptual question
          <input
            aria-label="Topic"
            value={topic}
            onChange={(e) => setTopic(e.target.value)}
          />
        </label>
        <label className="teaching-topic">
          Original question to leave for the child
          <input
            aria-label="Original question"
            value={homework}
            onChange={(e) => setHomework(e.target.value)}
          />
        </label>
        <button
          onClick={() =>
            run(() => {
              const next = new TeachingPlanner({
                sessionId: crypto.randomUUID(),
                topic,
                originalQuestion: homework,
              });
              abort.current?.abort();
              setBusy(false);
              director.reset();
              setPlanner(next);
              setAnswer("");
              setLastRequest(null);
              setChanges(0);
            })
          }
        >
          Start new lesson
        </button>
      </section>
      <div className="teaching-mode">
        <label>
          Planner source{" "}
          <select
            aria-label="Planner source"
            value={mode}
            disabled={busy}
            onChange={(e) => setMode(e.target.value)}
          >
            <option value="demo">Scripted offline fixtures</option>
            <option value="model">Model endpoint</option>
          </select>
        </label>
        {mode === "model" ? (
          <label>
            Server endpoint
            <input
              aria-label="Planning endpoint"
              value={endpoint}
              onChange={(e) => setEndpoint(e.target.value)}
            />
          </label>
        ) : (
          <span>Three sample topics · no AI or voice service connected</span>
        )}
      </div>
      <div className="teaching-layout">
        <TeachingCanvas
          canvas={visual.canvas}
          interactionEnabled={director.canInteract() && waiting}
          onMathAction={(action) => {
            if (visual.token && director.interactMath(visual.token, action))
              setChanges((x) => x + 1);
          }}
          onActivityAction={(action) => {
            if (visual.token && director.interactActivity(visual.token, action))
              setChanges((x) => x + 1);
          }}
        />
        <aside className="teaching-turn" aria-label="Teaching turn">
          <span className="teaching-kicker">
            {teaching.step?.phase.replaceAll("_", " ") ?? "Ready to diagnose"}
          </span>
          <h2>
            {teaching.step?.learningGoal ?? "Begin with what the child thinks."}
          </h2>
          <p className="teaching-narration" aria-live="polite">
            {visual.beat?.narration ??
              "Plan the first step to ask one short diagnostic question."}
          </p>
          {waiting && check && (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                respond({ kind: "answer", text: answer });
              }}
            >
              {check.kind === "choice" ? (
                <div className="teaching-options">
                  {check.options.map((option) => (
                    <button
                      type="button"
                      key={option.id}
                      onClick={() =>
                        respond({ kind: "choice", optionId: option.id })
                      }
                    >
                      {option.label}
                    </button>
                  ))}
                </div>
              ) : ["math_value", "placement", "order"].includes(check.kind) ? (
                <>
                  <p>{changes} canvas changes observed; submit when ready.</p>
                  <button
                    type="button"
                    onClick={() => respond({ kind: "interaction" })}
                  >
                    Submit my canvas
                  </button>
                </>
              ) : (
                <>
                  <label>
                    Your response
                    <input
                      aria-label="Learner response"
                      value={answer}
                      onChange={(e) => setAnswer(e.target.value)}
                    />
                  </label>
                  <button type="submit">Submit response</button>
                </>
              )}
              <div className="teaching-help">
                <button
                  type="button"
                  onClick={() => respond({ kind: "help", request: "simpler" })}
                >
                  Make it simpler
                </button>
                <button
                  type="button"
                  onClick={() =>
                    respond({ kind: "help", request: "another_way" })
                  }
                >
                  Show another way
                </button>
                <button
                  type="button"
                  onClick={() => respond({ kind: "help", request: "repeat" })}
                >
                  Repeat
                </button>
              </div>
            </form>
          )}
          {latest && (
            <p className="teaching-observation" role="status">
              Recorded: {latest.outcome.replaceAll("_", " ")} ·{" "}
              {latest.source.replaceAll("_", " ")}
            </p>
          )}
          {teaching.status === "presenting" ? (
            <button
              className="teaching-primary"
              onClick={() =>
                run(
                  () => teaching.step && playBeat(teaching.step, beatIndex + 1),
                )
              }
            >
              Present next beat
            </button>
          ) : (
            <button
              className="teaching-primary"
              disabled={busy || waiting || teaching.status === "completed"}
              onClick={plan}
            >
              {busy
                ? "Planning…"
                : teaching.status === "completed"
                  ? "Return to your original question"
                  : "Plan next teaching step"}
            </button>
          )}
          {busy && (
            <button
              onClick={() => {
                abort.current?.abort();
                setBusy(false);
              }}
            >
              Cancel planning
            </button>
          )}
          <small>
            Visual changes use the real director. Speech is shown as text in
            this harness.
          </small>
        </aside>
      </div>
      {error && (
        <p role="alert" className="teaching-error">
          {error}
        </p>
      )}
      <section className="teaching-recap">
        <h2>Evidence, not a guessed mastery score</h2>
        <p>
          {planner.recap().independentChecksPassed.length} independently checked
          examples passed. Interpretations of explanations remain tentative.
        </p>
        <ol>
          {teaching.evidence.map((e) => (
            <li key={e.eventId}>
              <strong>
                {e.phase.replaceAll("_", " ")} · {e.outcome}
              </strong>
              <span>{e.prompt}</span>
              <small>{e.observation}</small>
            </li>
          ))}
        </ol>
      </section>
      <details>
        <summary>Inspect model request, accepted step, and recap</summary>
        <pre>
          {JSON.stringify(
            {
              request: lastRequest,
              step: teaching.step,
              recap: planner.recap(),
            },
            null,
            2,
          )}
        </pre>
      </details>
    </main>
  );
}
