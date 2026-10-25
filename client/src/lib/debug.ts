// Per-tab event log, exposed as window.__tutor for the E2E harness (see client/README.md).
// Each tab has its own copy: nothing is shared between tabs.

export interface LogEvent {
  /** performance.now() in ms. */
  t: number;
  /** Date.now() in ms. */
  wall: number;
  type: string;
  [key: string]: unknown;
}

type Listener = (e: LogEvent) => void;

const MAX_EVENTS = 5000;

export class EventLog {
  readonly events: LogEvent[] = [];
  private listeners = new Set<Listener>();

  log(type: string, data: Record<string, unknown> = {}): LogEvent {
    const e: LogEvent = { t: performance.now(), wall: Date.now(), ...data, type };
    this.events.push(e);
    if (this.events.length > MAX_EVENTS) this.events.splice(0, this.events.length - MAX_EVENTS);
    for (const l of this.listeners) l(e);
    return e;
  }

  subscribe(l: Listener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  ofType(prefix: string): LogEvent[] {
    return this.events.filter(e => e.type === prefix || e.type.startsWith(prefix + '.'));
  }

  clear(): void {
    this.events.length = 0;
  }
}

export interface TutorDebug {
  log: EventLog;
  /** Shortcut to log.events. */
  readonly events: LogEvent[];
  ofType(prefix: string): LogEvent[];
  clear(): void;
  /** Filled by the active screen. */
  state: Record<string, unknown>;
  config?: unknown;
}

export const eventLog = new EventLog();

declare global {
  interface Window {
    __tutor: TutorDebug;
  }
}

export function installDebug(config: unknown): TutorDebug {
  const dbg: TutorDebug = {
    log: eventLog,
    get events() {
      return eventLog.events;
    },
    ofType: p => eventLog.ofType(p),
    clear: () => eventLog.clear(),
    state: {},
    config,
  };
  if (typeof window !== 'undefined') window.__tutor = dbg;
  return dbg;
}

/** JSON-safe summary of values that contain bigint / typed arrays. */
export function safe(v: unknown): unknown {
  if (typeof v === 'bigint') return v.toString();
  if (v instanceof Uint8Array || v instanceof Float32Array || v instanceof Int16Array) return `<${v.length}>`;
  if (Array.isArray(v)) return v.map(safe);
  if (v && typeof v === 'object') {
    const o: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) o[k] = safe(x);
    return o;
  }
  return v;
}
