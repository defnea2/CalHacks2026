// Globals the shared team code (@tutor/teaching) expects but the SpacetimeDB module runtime lacks.
// Imported first by index.ts. Measured on the local server: structuredClone is undefined there.
const g = globalThis as { structuredClone?: <T>(value: T) => T };
// The team code clones plain JSON data (canvas states, steps, evidence) only.
if (typeof g.structuredClone !== 'function') g.structuredClone = <T>(value: T): T => (value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T));
export {};
