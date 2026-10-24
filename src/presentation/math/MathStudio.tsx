import { useState, useSyncExternalStore } from "react";
import { TeachingCanvas } from "../TeachingCanvas";
import { VisualDirector } from "../VisualDirector";
import { compileMathCommand, type CompactMathCommand } from "./compact";

const explorations: { name: string; title: string; question: string; note: string; visual: CompactMathCommand }[] = [
  { name: "Area", title: "Make room for an idea", question: "Can two different rectangles cover the same amount of space?", note: "Stretch the corner. Each grid square is one square unit.", visual: { kind: "geometry", shape: "rectangle", width: 6, height: 4 } },
  { name: "Triangles", title: "Half of the same whole", question: "Why does this triangle cover half its rectangle?", note: "The dotted rectangle shares the triangle’s base and height.", visual: { kind: "geometry", shape: "right_triangle", width: 6, height: 4 } },
  { name: "Groups", title: "One total, two useful pieces", question: "Move the split. What changes, and what stays the same?", note: "Green and amber parts belong to the same whole.", visual: { kind: "array", rows: 3, columns: 7, splitAt: 5 } },
  { name: "Fractions", title: "Different names, equal amounts", question: "Can you make these two bars show the same amount?", note: "Both bars are the same size. Only the partitions and shading change.", visual: { kind: "bars", bars: [{ id: "a", label: "First whole", parts: 4, shaded: 2 }, { id: "b", label: "Second whole", parts: 8, shaded: 3 }] } },
  { name: "Number line", title: "Find your place", question: "How far apart are these numbers?", note: "Drag a point, or focus it and use the arrow keys.", visual: { kind: "number_line", min: 0, max: 1, markers: [{ id: "a", label: "A", value: 0.3 }, { id: "b", label: "B", value: 0.7 }] } },
];
function load(d: VisualDirector, index: number) {
  const item = explorations[index];
  const commands = compileMathCommand(item.visual, d.getSnapshot().canvas, { title: item.title, interactive: true, showEquation: true });
  const token = d.prepare({ id: `studio-${index}`, narration: item.question, cues: [{ id: "show", atMs: 0, commands: [...commands, { type: "note", text: item.note }] }] });
  d.narrationStarted(token); d.narrationEnded(token);
}
export function MathStudio({ onExit }: { onExit(): void }) {
  const [director] = useState(() => { const d = new VisualDirector(); load(d,0); return d; });
  const [index, setIndex] = useState(0);
  const state = useSyncExternalStore(director.subscribe, director.getSnapshot);
  const item = explorations[index];
  return <div className="math-studio">
    <div className="lesson-topline"><button className="lesson-back" onClick={onExit}>← All topics</button><span>Math studio · Works offline</span></div>
    <div className="lesson-title"><span className="lesson-eyebrow">CHANGE SOMETHING. NOTICE SOMETHING.</span><h1>Mathematics you can move.</h1><p>Try a new value. The picture and its equation stay connected.</p></div>
    <div className="studio-tabs" role="group" aria-label="Mathematical explorations">
      {explorations.map((x,i) => <button key={x.name} aria-pressed={i===index} onClick={() => { load(director,i); setIndex(i); }}>{x.name}</button>)}
    </div>
    <div className="lesson-stage">
      <TeachingCanvas canvas={state.canvas} interactionEnabled={director.canInteract()} onMathAction={action => director.interactMath(state.token!, action)} onActivityAction={action => director.interactActivity(state.token!, action)} />
      <aside className="studio-prompt"><span className="lesson-eyebrow">A QUESTION TO EXPLORE</span><h2>{item.question}</h2><p>{item.note}</p><div className="studio-local"><span aria-hidden="true">↔</span><div><strong>You move it. The math follows.</strong><p>These interactions run on your device, without waiting for a generated response.</p></div></div><button className="lesson-back" onClick={() => load(director,index)}>Reset this picture ↺</button></aside>
    </div>
  </div>;
}
