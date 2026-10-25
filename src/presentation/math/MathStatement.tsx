import { useMemo } from "react";
import katex from "katex";
import { compareFractions } from "../../visual-math/fractions";
import { geometryArea, mathSummary, type MathVisual } from "./models";
import "katex/dist/katex.min.css";

/** Only numeric model values enter TeX. Learner labels remain escaped React text. */
export function mathLatex(v: MathVisual): string | null {
  if (v.kind === "number_line") return null;
  if (v.kind === "geometry") return `A = ${v.width} \\times ${v.height}${v.shape === "right_triangle" ? " \\div 2" : ""} = ${geometryArea(v)}\\;\\text{square units}`;
  if (v.kind === "parallelogram") return `A = b \\times h = ${v.base} \\times ${v.height} = ${v.base * v.height}\\;\\text{square units}`;
  if (v.kind === "array") {
    const { rows: r, columns: c, splitAt: s } = v;
    return s === null ? `${r} \\times ${c} = ${r*c}`
      : `${r} \\times ${c} = \\htmlClass{math-first}{${r*s}} + \\htmlClass{math-second}{${r*(c-s)}} = ${r*c}`;
  }
  const [a,b] = v.bars;
  const frac = (x: typeof a) => `\\frac{${x.shaded}}{${x.parts}}`;
  if (!b) return frac(a);
  const cmp = compareFractions(a.shaded,a.parts,b.shaded,b.parts);
  return `${frac(a)} ${cmp === 0 ? "=" : cmp < 0 ? "<" : ">"} ${frac(b)}`;
}
export function MathStatement({ visual }: { visual: MathVisual }) {
  const latex = mathLatex(visual);
  const html = useMemo(() => latex === null ? null : katex.renderToString(latex, {
    throwOnError: false, strict: false, output: "html", maxExpand: 100,
    // htmlClass occurs only in the fixed, numeric expression constructed above.
    trust: context => context.command === "\\htmlClass",
  }), [latex]);
  return <output className="math-equation" aria-label="Linked mathematical statement" aria-live="polite">
    <span className="math-sr-only">{mathSummary(visual)}</span>
    {html ? <span aria-hidden="true" dangerouslySetInnerHTML={{ __html: html }} />
      : <span aria-hidden="true">{mathSummary(visual)}</span>}
    {visual.kind === "bars" && visual.bars.length > 1 && <small aria-hidden="true">Comparing equal wholes</small>}
  </output>;
}
