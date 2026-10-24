import { Coordinates, Line, Mafs, MovablePoint, Polygon, Text } from "mafs";
import type { MathChange, MathVisual } from "./models";
import "mafs/core.css";

const snap = (n: number) => Math.max(1, Math.min(12, Math.round(n * 2) / 2));
export function GeometryPicture({ visual: v, enabled, onChange }: {
  visual: Extract<MathVisual, { kind: "geometry" }>;
  enabled: boolean; onChange(change: MathChange): void;
}) {
  const triangle = v.shape === "right_triangle";
  const point: [number, number] = [v.width, v.height];
  const corners: [number, number][] = triangle ? [[0,0],[v.width,0],point] : [[0,0],[v.width,0],point,[0,v.height]];
  return <div className="math-geometry">
    <p className="math-geometry-caption">{triangle ? "A triangle inside its rectangle" : "Two lengths. One area."}</p>
    <div role="group" aria-label={`${triangle ? "Right triangle" : "Rectangle"}, base ${v.width}, height ${v.height}`}>
      <Mafs height={350} pan={false} zoom={false} viewBox={{ x: [-2,14], y: [-2,14], padding: 0 }}>
        <Coordinates.Cartesian xAxis={{ labels: false, axis: false }} yAxis={{ labels: false, axis: false }} />
        {triangle && <Polygon points={[[0,0],[v.width,0],point,[0,v.height]]} color="#b8723f" fillOpacity={0.04} strokeStyle="dashed" strokeOpacity={0.45} />}
        <Polygon points={corners} color="#24594b" fillOpacity={0.14} weight={2} />
        <Line.Segment point1={[0,0]} point2={[v.width,0]} color="#24594b" weight={3} />
        <Line.Segment point1={point} point2={[v.width,0]} color="#b8723f" weight={3} />
        <Text x={v.width/2} y={-0.8} size={16} color="#24594b">{v.width} units</Text>
        <Text x={v.width+0.65} y={v.height/2} attach="e" size={16} color="#9b5b30">{v.height}</Text>
        {enabled && <MovablePoint point={point} color="#24594b" constrain={([x,y]) => [snap(x),snap(y)]}
          onMove={([width,height]) => onChange({ type: "set_geometry", width, height })} />}
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
