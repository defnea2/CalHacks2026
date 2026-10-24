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
    switch (command.type) {
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
