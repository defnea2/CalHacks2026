import { lazy, Suspense, useState } from "react";
import { MathWorkbench } from "../presentation/math/MathWorkbench";
const GuidedWorkbench = lazy(() =>
  import("../presentation/GuidedWorkbench").then((module) => ({
    default: module.GuidedWorkbench,
  })),
);
const VisualSandbox = lazy(() =>
  import("../visuals/VisualSandbox").then((module) => ({
    default: module.VisualSandbox,
  })),
);
export default function App() {
  const [mode, setMode] = useState<"math" | "guided" | "components">("math");
  return (
    <main>
      <header className="workspace-header">
        <div>
          <span className="workspace-mark" aria-hidden="true">
            ∑
          </span>
          <h1>Tutor workspace</h1>
        </div>
        <p>Explain with a picture.</p>
      </header>
      <nav className="workbench-mode" aria-label="Workbench mode">
        <button aria-pressed={mode === "math"} onClick={() => setMode("math")}>
          Live math canvas
        </button>
        <button
          aria-pressed={mode === "guided"}
          onClick={() => setMode("guided")}
        >
          Guided explanation
        </button>
        <button
          aria-pressed={mode === "components"}
          onClick={() => setMode("components")}
        >
          Interactive building blocks
        </button>
      </nav>
      <Suspense fallback={<p role="status">Opening the building blocks…</p>}>
        {mode === "math" ? (
          <MathWorkbench />
        ) : mode === "guided" ? (
          <GuidedWorkbench />
        ) : (
          <VisualSandbox />
        )}
      </Suspense>
      <footer>Canvas tools · Local development workspace</footer>
    </main>
  );
}
