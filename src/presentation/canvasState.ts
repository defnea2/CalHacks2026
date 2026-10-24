import { createScene } from "../shared";
import { applySceneCommand } from "../session/sceneReducer";
import { updateMathVisual } from "./math/models";
import {
  CanvasCommandSchema,
  emptyCanvas,
  type CanvasState,
} from "./contracts";

/** Apply an entire cue transactionally. Failed commands never leave a half-drawn scene. */
export function applyCanvasCommands(
  current: CanvasState,
  inputs: unknown[],
): CanvasState {
  let next: CanvasState = structuredClone(current);
  for (const input of inputs) {
    const command = CanvasCommandSchema.parse(input);
    const known = (id: string) => next.nodes.some((node) => node.id === id);
    const requireNode = (id: string) => {
      if (!known(id)) throw new Error(`Unknown canvas object: ${id}`);
    };
    if ((next.math || next.activity) && ["add", "update", "remove", "connect", "highlight", "point"].includes(command.type))
      throw new Error("Use clear before switching from a workspace to free-form objects.");
    switch (command.type) {
      case "show_math":
        next = { ...emptyCanvas(), title: command.visual.title, math: { visual: command.visual, revision: 0, appliedEventIds: [] } };
        break;
      case "update_math":
        if (!next.math || next.math.visual.id !== command.id) throw new Error("Unknown math visual.");
        next.math.visual = updateMathVisual(next.math.visual, command.change);
        next.math.revision += 1;
        break;
      case "show_activity":
        next = { ...emptyCanvas(), title: command.activity.title, activity: createScene(command.activity, command.sceneId) };
        break;
      case "activity_command": {
        if (!next.activity) throw new Error("No activity is active.");
        const result = applySceneCommand(next.activity, command.command);
        if (!result.ok) throw new Error(result.message);
        next.activity = result.scene;
        next.title = result.scene.activity.title;
        break;
      }
      case "clear":
        next = { ...emptyCanvas(), title: command.title };
        break;
      case "add":
        for (const node of command.nodes) {
          if (known(node.id))
            throw new Error(`Duplicate canvas object: ${node.id}`);
          next.nodes.push(node);
        }
        break;
      case "update":
        requireNode(command.id);
        next.nodes = next.nodes.map((node) =>
          node.id === command.id ? { ...node, ...command.patch } : node,
        );
        break;
      case "remove":
        command.ids.forEach(requireNode);
        next.nodes = next.nodes.filter(
          (node) => !command.ids.includes(node.id),
        );
        next.edges = next.edges.filter(
          (edge) => known(edge.from) && known(edge.to),
        );
        next.highlightedIds = next.highlightedIds.filter(known);
        if (next.pointer && !known(next.pointer.id)) next.pointer = null;
        break;
      case "connect":
        for (const edge of command.edges) {
          requireNode(edge.from);
          requireNode(edge.to);
          if (edge.from === edge.to)
            throw new Error("A connection needs two different objects.");
          if (
            next.edges.some(
              (e) =>
                e.id === edge.id || (e.from === edge.from && e.to === edge.to),
            )
          )
            throw new Error("Duplicate connection.");
          next.edges.push(edge);
        }
        break;
      case "highlight":
        command.ids.forEach(requireNode);
        next.highlightedIds = [...new Set(command.ids)];
        break;
      case "point":
        if (command.id) requireNode(command.id);
        next.pointer = command.id
          ? { id: command.id, label: command.label }
          : null;
        break;
      case "note":
        next.note = command.text;
        break;
    }
    if (next.nodes.length > 40 || next.edges.length > 24)
      throw new Error(
        "This canvas is full; start a new scene or remove objects.",
      );
  }
  return next;
}
