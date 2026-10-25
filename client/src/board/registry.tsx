// Renderer registry: board kind name -> renderer. Together with the lesson pack's board kinds
// this is the replaceable boundary; kind names appear nowhere else in the client.
import type { BoardRenderer, RendererProps } from './types';
import { EquationRenderer, GapTaskRenderer, TextRenderer, WorkedStepsRenderer } from './renderers/basic';
import { MathCanvasRenderer } from './AnimatedMathBoard';
import { VisualRenderer } from './renderers/visual';

export const renderers: Record<string, BoardRenderer> = {
  math_canvas: MathCanvasRenderer,
  text: TextRenderer,
  equation: EquationRenderer,
  worked_steps: WorkedStepsRenderer,
  gap_task: GapTaskRenderer,
  visual: VisualRenderer,
};

/** Neutral fallback for unknown kinds: title + raw content, never an error. */
export function FallbackRenderer({ content, kind }: RendererProps & { kind?: string }) {
  const title = typeof content.title === 'string' ? content.title : kind ?? 'Board item';
  return (
    <div className="flex flex-col gap-1" data-testid="board-fallback">
      <p className="font-medium">{title}</p>
      <pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded bg-muted p-2 text-xs">{JSON.stringify(content, null, 2)}</pre>
    </div>
  );
}

export function getRenderer(kind: string): { renderer: BoardRenderer; known: boolean } {
  const r = Object.prototype.hasOwnProperty.call(renderers, kind) ? renderers[kind] : undefined;
  return r ? { renderer: r, known: true } : { renderer: FallbackRenderer as BoardRenderer, known: false };
}

/** Parses item content; invalid JSON becomes {raw} so the fallback can show it. */
export function parseContent(json: string): Record<string, unknown> {
  try {
    const v: unknown = JSON.parse(json);
    if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>;
    return { value: v };
  } catch {
    return { raw: json };
  }
}
