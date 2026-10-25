// Tool registry: joins the pack-generated tool specs (name, description, JSON Schema) with the
// worker's handler modules. To add a tool: add its spec to buildToolSpecs and a module here.
import { buildToolSpecs, type LessonPack, type ToolSpec } from '@tutor/shared';
import type { ToolDef, ToolModule } from './types';
import { setTopic } from './set_topic';
import { setPhase } from './set_phase';
import { showBoardItem } from './show_board_item';
import { clearBoard } from './clear_board';
import { remember } from './remember';
import { visualUnavailable } from './visual_unavailable';
import { askLearner } from './ask_learner';

export const TOOL_MODULES: ToolModule[] = [setTopic, setPhase, showBoardItem, clearBoard, remember, visualUnavailable, askLearner];

export function createToolDefs(pack: LessonPack, modules: ToolModule[] = TOOL_MODULES, specs: ToolSpec[] = buildToolSpecs(pack)): ToolDef[] {
  const byName = new Map(modules.map(m => [m.name, m]));
  const defs: ToolDef[] = [];
  for (const spec of specs) {
    const mod = byName.get(spec.name);
    if (!mod) {
      console.warn(`[tools] no handler for tool ${spec.name}; not offered to the LLM`);
      continue;
    }
    defs.push({ ...mod, name: spec.name, description: spec.description, parameters: spec.parameters });
  }
  return defs;
}

export type { ToolDef, ToolModule, ToolContext } from './types';
