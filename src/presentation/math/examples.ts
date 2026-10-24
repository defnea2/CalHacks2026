import { MathVisualSchema, type MathVisual } from "./models";

/** Local deterministic examples for integration testing. This does not infer mastery. */
export function createMathExample(
  current: MathVisual,
  intent: "simpler" | "variation",
): MathVisual {
  const next = structuredClone(current);
  next.focus = null;
  next.interactive = true;
  if (next.kind === "array") {
    if (intent === "simpler") {
      next.rows = Math.max(1, Math.ceil(next.rows / 2));
      next.columns = Math.max(1, Math.ceil(next.columns / 2));
    } else next.columns = next.columns === 20 ? 2 : next.columns + 1;
    next.splitAt =
      next.splitAt === null || next.columns === 1
        ? null
        : Math.min(next.splitAt, next.columns - 1);
  } else if (next.kind === "bars") {
    next.bars = next.bars.map((bar, i) =>
      intent === "simpler"
        ? { ...bar, parts: i % 2 === 0 ? 2 : 4, shaded: 1 }
        : { ...bar, shaded: (bar.shaded + 1) % (bar.parts + 1) },
    );
  } else if (next.kind === "geometry") {
    next.width = intent === "simpler" ? Math.max(1, Math.ceil(next.width / 2)) : next.width === 12 ? 2 : Math.min(12, next.width + 1);
  } else if (intent === "simpler") {
    const span = next.max - next.min;
    next.markers = next.markers.map((marker) => ({
      ...marker,
      value: Math.round(((marker.value - next.min) / span) * 10),
    }));
    next.min = 0;
    next.max = 10;
  } else {
    const span = next.max - next.min;
    next.markers = next.markers.map((marker) => ({
      ...marker,
      value: Math.min(
        next.max,
        Math.max(
          next.min,
          Number(
            (marker.value + span / 10 > next.max
              ? next.min
              : marker.value + span / 10
            ).toFixed(6),
          ),
        ),
      ),
    }));
  }
  return MathVisualSchema.parse(next);
}
