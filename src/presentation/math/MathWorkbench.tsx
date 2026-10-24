import { useState, useSyncExternalStore } from "react";
import { fixtureKeys, type FixtureKey } from "../../shared/fixtures";
import { LiveControls } from "./LiveControls";
import { createMathExample } from "./examples";
import type { BeatInput, CommandInput } from "../contracts";
import { TeachingCanvas } from "../TeachingCanvas";
import { VisualDirector } from "../VisualDirector";
import {
  activityRehearsal,
  arrayRehearsal,
  barRehearsal,
  numberLineRehearsal,
} from "./rehearsals";
import "./workbench.css";

type Scenario = "array" | "number_line" | "bars" | `activity:${FixtureKey}`;
export function MathWorkbench() {
  const [director] = useState(() => new VisualDirector());
  const snapshot = useSyncExternalStore(
    director.subscribe,
    director.getSnapshot,
  );
  const [scenario, setScenario] = useState<Scenario>("array");
  const [numbers, setNumbers] = useState({ rows: 3, columns: 14, splitAt: 10 });
  const [appliedNumbers, setAppliedNumbers] = useState(numbers);
  const [steps, setSteps] = useState(arrayRehearsal);
  const [next, setNext] = useState(0);
  const [custom, setCustom] = useState(false);
  const [editor, setEditor] = useState(JSON.stringify(steps[0].beat, null, 2));
  const [error, setError] = useState("");
  const [events, setEvents] = useState<unknown[]>([]);
  const log = (value: unknown) =>
    setEvents((old) => [value, ...old].slice(0, 12));
  const attempt = (work: () => void) => {
    try {
      work();
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Invalid visual step.");
    }
  };
  const resetScenario = (value: Scenario, configuration = appliedNumbers) => {
    director.reset();
    setNext(0);
    setCustom(false);
    setEvents([]);
    setError("");
    setScenario(value);
    const newSteps =
      value === "array"
        ? arrayRehearsal(
            configuration.rows,
            configuration.columns,
            configuration.splitAt,
          )
        : value === "number_line"
          ? numberLineRehearsal()
          : value === "bars"
            ? barRehearsal()
            : activityRehearsal(value.slice(9) as FixtureKey);
    setSteps(newSteps);
    setEditor(JSON.stringify(newSteps[0].beat, null, 2));
  };
  const run = (
    beat: BeatInput,
    expectedContextVersion = director.getSnapshot().contextVersion,
  ) => {
    const token = director.prepare(beat, { expectedContextVersion });
    director.narrationStarted(token);
    director.narrationEnded(token);
    setEditor(JSON.stringify(beat, null, 2));
    log({ type: "step_completed", token, beatId: beat.id });
  };
  const applyLive = (commands: CommandInput[], narration: string) =>
    attempt(() => {
      const context = director.getPlanningContext();
      run(
        {
          id: `live-${crypto.randomUUID()}`,
          narration,
          cues: [
            {
              id: "live-change",
              atMs: 0,
              commands: [...commands, { type: "note", text: narration }],
            },
          ],
        },
        context.contextVersion,
      );
      setCustom(true);
    });
  const playing = ["ready", "speaking", "paused"].includes(snapshot.status);
  return (
    <div className="math-rehearsal">
      <div className="guided-toolbar">
        <label>
          Representation{" "}
          <select
            aria-label="Math rehearsal"
            value={scenario}
            onChange={(e) => resetScenario(e.target.value as Scenario)}
          >
            <option value="array">Multiplication · arrays</option>
            <option value="number_line">Decimals · number lines</option>
            <option value="bars">Fractions · equal bars</option>
            {fixtureKeys
              .filter((key) => !["bars", "line"].includes(key))
              .map((key) => (
                <option key={key} value={`activity:${key}`}>
                  Activity · {key}
                </option>
              ))}
          </select>
        </label>
        <span className="guided-demo-badge">
          Manual tutor · voice not connected
        </span>
      </div>
      <div className="math-rehearsal-grid">
        <TeachingCanvas
          canvas={snapshot.canvas}
          interactionEnabled={director.canInteract()}
          choiceIds={
            snapshot.status === "awaiting_answer"
              ? snapshot.beat?.question?.nodeIds
              : []
          }
          onChoose={(id) => {
            const result = director.respond(id);
            if (result) log(result);
          }}
          onMathAction={(action) => {
            if (snapshot.token) {
              const result = director.interactMath(snapshot.token, action);
              if (result) log(result);
            }
          }}
          onActivityAction={(action) => {
            if (snapshot.token) {
              const result = director.interactActivity(snapshot.token, action);
              if (result) log(result);
            }
          }}
        />
        <aside className="math-director-panel" aria-label="Simulated tutor">
          <span className="eyebrow">
            {custom ? "Live configuration" : "Teaching sequence"}
          </span>
          <h2>{snapshot.beat ? "Explanation" : "Start an example"}</h2>
          <p className="math-script" aria-live="polite">
            {snapshot.beat?.narration ??
              "Build a representation, follow the explanation, then change its quantities. The diagram and its mathematical statement stay connected."}
          </p>
          {!custom && (
            <ol className="math-step-list">
              {steps.map((step, index) => (
                <li
                  key={step.beat.id}
                  aria-current={index === next - 1 ? "step" : undefined}
                  className={index < next ? "visited" : ""}
                >
                  <span>{index + 1}</span>
                  {step.title}
                </li>
              ))}
            </ol>
          )}
          {!custom && (
            <button
              className="math-next"
              disabled={next >= steps.length || playing}
              onClick={() =>
                attempt(() => {
                  run(steps[next].beat);
                  setNext(next + 1);
                })
              }
            >
              {next === 0
                ? "Build the first visual"
                : next < steps.length
                  ? "Next teaching step"
                  : "Explore on the canvas"}
            </button>
          )}
          <button
            className="math-restart"
            onClick={() => resetScenario(scenario)}
          >
            Restart this example
          </button>
          {error && (
            <p role="alert" className="preview-error">
              {error}
            </p>
          )}
          {snapshot.canvas.math && (
            <LiveControls
              visual={snapshot.canvas.math.visual}
              disabled={playing}
              onCommands={applyLive}
              onExample={(intent) => {
                const visual = director.getSnapshot().canvas.math?.visual;
                if (visual)
                  applyLive(
                    [
                      {
                        type: "show_math",
                        visual: createMathExample(visual, intent),
                      },
                    ],
                    intent === "simpler"
                      ? "Explore a smaller-number example based on the current picture."
                      : "Try a new set of quantities based on the current picture.",
                  );
              }}
            />
          )}
          <p className="math-status">
            {snapshot.status.replaceAll("_", " ")} ·{" "}
            {snapshot.canvas.math
              ? `visual revision ${snapshot.canvas.math.revision}`
              : `${snapshot.appliedCueIds.length} cues applied`}
          </p>
        </aside>
      </div>
      {scenario === "array" && (
        <details className="preview-panel">
          <summary>Try your own numbers</summary>
          <p>
            Generate the same explanation with different quantities. This
            changes parameters, not lesson code.
          </p>
          <div className="math-number-inputs">
            {(["rows", "columns", "splitAt"] as const).map((key) => (
              <label key={key}>
                {
                  {
                    rows: "Starting groups",
                    columns: "In each group",
                    splitAt: "Split after",
                  }[key]
                }
                <input
                  aria-label={
                    {
                      rows: "Starting groups",
                      columns: "In each group",
                      splitAt: "Split after",
                    }[key]
                  }
                  type="number"
                  min={key === "columns" ? 2 : 1}
                  max={key === "rows" ? 11 : key === "columns" ? 20 : 19}
                  value={numbers[key]}
                  onChange={(e) =>
                    setNumbers({ ...numbers, [key]: Number(e.target.value) })
                  }
                />
              </label>
            ))}
          </div>
          <button
            onClick={() =>
              attempt(() => {
                if (
                  ![numbers.rows, numbers.columns, numbers.splitAt].every(
                    Number.isInteger,
                  ) ||
                  numbers.rows < 1 ||
                  numbers.rows > 11 ||
                  numbers.columns < 2 ||
                  numbers.columns > 20 ||
                  numbers.splitAt < 1 ||
                  numbers.splitAt >= numbers.columns
                )
                  throw new Error(
                    "Use 1–11 groups, 2–20 in each group, and a split inside the group.",
                  );
                setAppliedNumbers(numbers);
                resetScenario("array", numbers);
              })
            }
          >
            Use these numbers
          </button>
        </details>
      )}
      <details className="preview-panel">
        <summary>Send a visual step as JSON</summary>
        <p>
          Edit a VisualBeat, prepare it, then simulate playback callbacks.
          Preparation validates the whole plan without changing the picture.
        </p>
        <textarea
          aria-label="Visual step JSON"
          className="preview-json"
          value={editor}
          onChange={(e) => setEditor(e.target.value)}
          spellCheck={false}
        />
        <div className="preview-editor-actions">
          <button
            onClick={() =>
              attempt(() => {
                const token = director.prepare(JSON.parse(editor), {
                  expectedContextVersion: snapshot.contextVersion,
                });
                setCustom(true);
                log({ type: "prepared", token });
              })
            }
          >
            Prepare JSON step
          </button>
          <button
            disabled={!["ready", "paused"].includes(snapshot.status)}
            onClick={() =>
              snapshot.token && director.narrationStarted(snapshot.token)
            }
          >
            Start / resume
          </button>
          <button
            disabled={snapshot.status !== "speaking"}
            onClick={() => {
              const cue = snapshot.beat?.cues.find(
                (c) => !snapshot.appliedCueIds.includes(c.id),
              );
              if (cue && snapshot.token)
                director.narrationProgress(snapshot.token, cue.atMs);
            }}
          >
            Advance to next cue
          </button>
          <button
            disabled={snapshot.status !== "speaking"}
            onClick={() =>
              snapshot.token && director.narrationPaused(snapshot.token)
            }
          >
            Pause
          </button>
          <button
            disabled={!["speaking", "paused"].includes(snapshot.status)}
            onClick={() =>
              snapshot.token && director.narrationEnded(snapshot.token)
            }
          >
            Finish step
          </button>
          <button
            disabled={!snapshot.token}
            onClick={() => snapshot.token && director.interrupt(snapshot.token)}
          >
            Interrupt
          </button>
          <button disabled={!snapshot.beat} onClick={() => director.replay()}>
            Prepare replay
          </button>
        </div>
      </details>
      <details className="preview-panel">
        <summary>Inspect scene and learner events</summary>
        <p>
          These accepted events include the updated representation for the
          tutor. This log is local to this preview.
        </p>
        <pre aria-label="Learner event log">
          {JSON.stringify(events, null, 2)}
        </pre>
        <pre aria-label="Current canvas state">
          {JSON.stringify(snapshot, null, 2)}
        </pre>
      </details>
    </div>
  );
}
