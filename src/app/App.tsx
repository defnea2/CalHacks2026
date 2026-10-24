import { lazy, Suspense, useState } from "react";
import { LessonWorkspace } from "../teaching/ui/LessonWorkspace";
const MathWorkbench = lazy(() => import("../presentation/math/MathWorkbench").then(m => ({ default: m.MathWorkbench })));
const GuidedWorkbench = lazy(() => import("../presentation/GuidedWorkbench").then(m => ({ default: m.GuidedWorkbench })));
const VisualSandbox = lazy(() => import("../visuals/VisualSandbox").then(m => ({ default: m.VisualSandbox })));
export default function App() {
  const [tools, setTools] = useState(false);
  const [mode, setMode] = useState<"math" | "guided" | "components">("math");
  return <main className="product-shell">
    <header className="product-header">
      <div className="product-identity"><span className="product-monogram" aria-hidden="true">t</span><strong>Tutor</strong></div>
      <button aria-pressed={tools} onClick={() => setTools(!tools)}>{tools ? "Back to my lesson" : "Development tools"}</button>
    </header>
    <div hidden={tools}><LessonWorkspace /></div>
    {tools && <section className="product-tools" aria-label="Development tools">
      <nav className="workbench-mode" aria-label="Workbench mode">
        <button aria-pressed={mode === "math"} onClick={() => setMode("math")}>Live math canvas</button>
        <button aria-pressed={mode === "guided"} onClick={() => setMode("guided")}>Guided explanation</button>
        <button aria-pressed={mode === "components"} onClick={() => setMode("components")}>Interactive building blocks</button>
      </nav>
      <Suspense fallback={<p role="status">Opening the tools…</p>}>
        {mode === "math" ? <MathWorkbench /> : mode === "guided" ? <GuidedWorkbench /> : <VisualSandbox />}
      </Suspense>
    </section>}
    <footer>Refresh starts a new session</footer>
  </main>;
}
