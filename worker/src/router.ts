// ToolRouter: one LLM tool call -> one handler run. Never throws: bad JSON, unknown tools,
// reducer errors and timeouts all come back as "error: ..." results the model can read.
import type { ChatToolCall, ToolSpec } from '@tutor/shared';
import type { ToolContext, ToolDef } from './tools/types';

export interface ToolResult {
  call: ChatToolCall;
  kind: 'action' | 'query' | 'unknown';
  ok: boolean;
  result: string;
}

const errText = (e: unknown) => (e instanceof Error ? e.message : typeof e === 'string' ? e : JSON.stringify(e));

export class ToolRouter {
  private readonly byName: Map<string, ToolDef>;

  constructor(
    readonly tools: ToolDef[],
    private readonly defaultTimeoutMs: number
  ) {
    this.byName = new Map(tools.map(t => [t.name, t]));
  }

  /** Specs offered to the LLM. */
  specs(): ToolSpec[] {
    return this.tools.map(t => ({ name: t.name, description: t.description, parameters: t.parameters }));
  }

  kindOf(name: string): 'action' | 'query' | 'unknown' {
    return this.byName.get(name)?.kind ?? 'unknown';
  }

  async run(call: ChatToolCall, ctx: ToolContext): Promise<ToolResult> {
    const tool = this.byName.get(call.name);
    if (!tool) return { call, kind: 'unknown', ok: false, result: `error: unknown tool ${call.name}` };
    let args: Record<string, unknown>;
    try {
      const parsed: unknown = call.arguments.trim() ? JSON.parse(call.arguments) : {};
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('arguments must be a JSON object');
      args = parsed as Record<string, unknown>;
    } catch (e) {
      return { call, kind: tool.kind, ok: false, result: `error: invalid arguments: ${errText(e)}` };
    }
    const timeoutMs = tool.timeoutMs ?? this.defaultTimeoutMs;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        tool.handler(args, ctx),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`timed out after ${timeoutMs} ms`)), timeoutMs);
        }),
      ]);
      return { call, kind: tool.kind, ok: true, result };
    } catch (e) {
      return { call, kind: tool.kind, ok: false, result: `error: ${errText(e)}` };
    } finally {
      clearTimeout(timer);
    }
  }
}
