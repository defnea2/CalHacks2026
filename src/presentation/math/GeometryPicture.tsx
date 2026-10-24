import { useEffect, useRef, useState } from "react";
import { useReducedMotion } from "motion/react";
import { Coordinates, Line, Mafs, MovablePoint, Polygon, Text } from "mafs";
import type { MathChange, MathVisual } from "./models";
import "mafs/core.css";

const snap = (n: number) => Math.max(1, Math.min(12, Math.round(n * 2) / 2));
export function GeometryPicture({ visual: v, enabled, onChange, animateChanges = false }: {
  visual: Extract<MathVisual, { kind: "geometry" }>;
  enabled: boolean; onChange(change: MathChange): void; animateChanges?: boolean;
}) {
  const reduced = useReducedMotion();
  const [drawn, setDrawn] = useState({ width: v.width, height: v.height });
  const current = useRef(drawn);
  const [previous, setPrevious] = useState<typeof drawn | null>(null);
  useEffect(() => {
    const from = current.current, to = { width: v.width, height: v.height };
    if (!animateChanges || reduced || (from.width === to.width && from.height === to.height)) {
      current.current = to; setDrawn(to); setPrevious(null); return;
    }
    setPrevious(from);
    const start = performance.now();
    let frame: number;
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / 1000);
      const eased = 1 - Math.pow(1-t, 3);
      const next = { width: from.width + (to.width-from.width)*eased, height: from.height + (to.height-from.height)*eased };
      current.current = next; setDrawn(next);
      if (t < 1) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [v.width, v.height, animateChanges, reduced]);
  const triangle = v.shape === "right_triangle";
  // A fixed origin makes added rows/columns visible instead of stretching both edges.
  const left = 0, bottom = 0;
  const x = left + drawn.width, y = bottom + drawn.height;
  const point: [number, number] = [x, y];
  const corners: [number, number][] = triangle ? [[left,bottom],[x,bottom],point] : [[left,bottom],[x,bottom],point,[left,y]];
  return <div className="math-geometry">
    <p className="math-geometry-caption">{triangle ? "A triangle inside its rectangle" : "Each grid square is one square unit."}</p>
    <div role="group" aria-label={`${triangle ? "Right triangle" : "Rectangle"}, base ${v.width}, height ${v.height}`}>
      <Mafs height={300} pan={false} zoom={false} viewBox={{ x: [-1,13], y: [-1,Math.max(5, v.height + 1)], padding: 0 }}>
        <Coordinates.Cartesian xAxis={{ labels: false, axis: false }} yAxis={{ labels: false, axis: false }} />
        {triangle && <Polygon points={[[left,bottom],[x,bottom],point,[left,y]]} color="#b8723f" fillOpacity={0.04} strokeStyle="dashed" strokeOpacity={0.45} />}
        {previous && !triangle && <Polygon points={[[left,bottom],[left+previous.width,bottom],[left+previous.width,bottom+previous.height],[left,bottom+previous.height]]} color="#b8723f" fillOpacity={0.04} strokeStyle="dashed" weight={2} />}
        <Polygon points={corners} color="#24594b" fillOpacity={0.14} weight={2} />
        <Line.Segment point1={[left,bottom]} point2={[x,bottom]} color="#24594b" weight={3} />
        <Line.Segment point1={point} point2={[x,bottom]} color="#b8723f" weight={3} />
        <Text x={left+drawn.width/2} y={bottom-0.8} size={16} color="#24594b">{v.width} units</Text>
        <Text x={x+0.65} y={bottom+drawn.height/2} attach="e" size={16} color="#9b5b30">{v.height}</Text>
        {enabled && <MovablePoint point={point} color="#24594b" constrain={([a,b]) => [left+snap(a-left),bottom+snap(b-bottom)]}
          onMove={([a,b]) => onChange({ type: "set_geometry", width: snap(a-left), height: snap(b-bottom) })} />}
      </Mafs>
    </div>
    {v.interactive && <fieldset className="math-controls" disabled={!enabled}>
      <legend>Drag the corner, or adjust a length</legend>
      {(["width","height"] as const).map(key => <label key={key}>{key === "width" ? "Base" : "Height"}
        <input aria-label={`Geometry ${key}`} type="range" min="1" max="12" step="0.5" value={v[key]}
          onChange={e => onChange({ type: "set_geometry", [key]: Number(e.target.value) })} /><output>{v[key]}</output>
      </label>)}
    </fieldset>}
  </div>;
}
