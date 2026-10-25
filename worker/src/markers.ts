// Reveal anchors of one reply: which sentence (and character offset in its speech) each inline
// marker ⟦id⟧ ended up in. Tool-agnostic: a board tool asks `take(id)` for the anchor of the id
// it was given; a later combined tool can do the same per item.
import { markerIds, normalizeMarkerId, type SentenceMarker } from '@tutor/shared';

export interface Anchor {
  sentenceIdx: number;
  /** Character offset in that sentence's speech text. */
  pos: number;
}

export class MarkerAnchors {
  /** Unconsumed anchors per id, in speaking order (a reused id maps to the next one). */
  private readonly byId = new Map<string, Anchor[]>();
  /** Ids seen in the text stream so far (before their sentence got an index). */
  private readonly seen = new Set<string>();
  /** Markers of a marker-only piece before any sentence: they go to the next sentence start. */
  private leading: SentenceMarker[] = [];
  private lastIdx = -1;
  /** For the reply log: ids resolved / asked for without a marker. */
  readonly resolved: string[] = [];
  readonly missing: string[] = [];
  private lastSpeechLength = 0;

  /** Stream time: note the markers of a chunker piece as soon as it is cut. */
  noteText(raw: string): void {
    for (const id of markerIds(raw)) this.seen.add(id);
  }

  /** The tool call refers to a marker whose sentence is not cut yet (still in the chunker). */
  waitsFor(argumentsJson: string): boolean {
    return referencedMarkerIds(argumentsJson).some(id => !this.seen.has(id));
  }

  /** A sentence got index `idx`: register its markers. */
  addSentence(idx: number, speechLength: number, markers: SentenceMarker[]): void {
    for (const m of this.leading.splice(0)) this.push(m.id, { sentenceIdx: idx, pos: 0 });
    for (const m of markers) this.push(m.id, { sentenceIdx: idx, pos: m.pos });
    this.lastIdx = idx;
    this.lastSpeechLength = speechLength;
  }

  /** A piece that was only markers (e.g. "⟦b3⟧" after the last "?"): they belong to the end of
   *  the previous sentence, or to the start of the next one when there is none yet. */
  addMarkerOnly(markers: SentenceMarker[]): void {
    if (this.lastIdx < 0) {
      this.leading.push(...markers);
      return;
    }
    for (const m of markers) this.push(m.id, { sentenceIdx: this.lastIdx, pos: this.lastSpeechLength });
  }

  /** The anchor for a tool's `id`, consumed. Undefined: no such marker (item keeps the
   *  default reveal at the next sentence). */
  take(id: unknown): Anchor | undefined {
    if (typeof id !== 'string' || !id.trim()) {
      this.missing.push('(no id)');
      return undefined;
    }
    const key = normalizeMarkerId(id);
    const a = this.byId.get(key)?.shift();
    (a ? this.resolved : this.missing).push(key);
    return a;
  }

  /** Markers spoken but never claimed by a tool call. */
  unclaimed(): string[] {
    return [...this.byId].flatMap(([id, list]) => list.map(() => id));
  }

  /** One-line summary for the reply log ('' when the reply had no markers). */
  summary(): string {
    const un = this.unclaimed();
    if (!this.resolved.length && !this.missing.length && !un.length) return '';
    return `markers: ${this.resolved.length} anchored${this.missing.length ? `, no marker for [${this.missing.join(',')}]` : ''}${un.length ? `, unclaimed [${un.join(',')}]` : ''}`;
  }

  private push(id: string, a: Anchor): void {
    const list = this.byId.get(id) ?? [];
    list.push(a);
    this.byId.set(id, list);
  }
}

/** Marker ids a tool call refers to: a top-level `id`, or `id` of entries of an `items` array. */
export function referencedMarkerIds(argumentsJson: string): string[] {
  let args: unknown;
  try {
    args = argumentsJson.trim() ? JSON.parse(argumentsJson) : {};
  } catch {
    return [];
  }
  if (typeof args !== 'object' || args === null) return [];
  const out: string[] = [];
  const add = (v: unknown) => {
    if (typeof v === 'string' && v.trim()) out.push(normalizeMarkerId(v));
  };
  const a = args as { id?: unknown; items?: unknown };
  add(a.id);
  if (Array.isArray(a.items)) for (const it of a.items) if (it && typeof it === 'object') add((it as { id?: unknown }).id);
  return out;
}
