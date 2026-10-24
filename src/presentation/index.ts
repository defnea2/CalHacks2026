export { VisualDirector } from "./VisualDirector";
export type { DirectorSnapshot, DirectorStatus } from "./VisualDirector";
export { TeachingCanvas } from "./TeachingCanvas";
export type { TeachingCanvasProps } from "./TeachingCanvas";
export { NarrationAudio } from "./NarrationAudio";
export { VisualBeatSchema, CanvasCommandSchema } from "./contracts";
export type {
  VisualBeat,
  BeatInput,
  CanvasCommand,
  CommandInput,
  CanvasState,
  CanvasNode,
  NodeInput,
  PlaybackToken,
  CanvasResponse,
} from "./contracts";
export {
  MathVisualSchema,
  MathChangeSchema,
  MathActionSchema,
  mathSummary,
} from "./math/models";
export type {
  MathVisual,
  MathVisualInput,
  MathChange,
  MathScene,
  MathAction,
} from "./math/models";
export { createMathExample } from "./math/examples";

export { CompactMathCommandSchema, compileMathCommand } from "./math/compact";
export type { CompactMathCommand } from "./math/compact";
