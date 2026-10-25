import { VisualDirector } from '../VisualDirector';
import { applyCanvasCommands } from '../canvasState';
import { emptyCanvas } from '../contracts';
import type { MathAction } from '../math/models';
import { compileMathCommand } from '../math/compact';
import { VoiceCanvasContentSchema } from './contracts';

export interface SpeechCanvasItem {
  id: string;
  order: number;
  utteranceId: string;
  sentenceIdx: number;
  content: unknown;
}
export type StartedSentences = ReadonlyMap<string, readonly number[]>;

/** The same persistent director drives speech and the manual, voice-free preview.
 * No wall-clock timers: a cue can run only after its exact sentence starts.
 */
export class SpeechCanvasPlayer {
  readonly director = new VisualDirector();
  private lastOrder = -1;
  private lastMoment = -1;
  private knownIds = new Set<string>();
  private failed = new Set<string>();
  private allowInteraction = false;
  error: string | null = null;

  sync(items: readonly SpeechCanvasItem[], started: StartedSentences, allowInteraction: boolean) {
    this.allowInteraction = allowInteraction;
    const ids = new Set(items.map(i => i.id));
    // Clear-board hides the previous rows. A new board starts a new presentation epoch.
    if ([...this.knownIds].some(id => !ids.has(id))) this.reset();
    this.knownIds = ids;
    for (const item of [...items].sort((a, b) => a.order - b.order)) {
      if (item.order < this.lastOrder || this.failed.has(item.id)) continue;
      try {
        const content = VoiceCanvasContentSchema.parse(item.content);
        if (content.moments[0].sentenceOffset !== 0 || ['keep', 'update'].includes(content.moments[0].visual.kind))
          throw new Error('Start each canvas explanation with a complete picture at sentence offset zero.');
        let preflight = emptyCanvas();
        // Validate the entire sequence before touching the currently visible picture.
        content.moments.forEach((m, index) => {
          if (index && m.sentenceOffset <= content.moments[index - 1].sentenceOffset)
            throw new Error('Canvas sentence offsets must increase.');
          if (m.interactive && index !== content.moments.length - 1)
            throw new Error('Only the final picture may enable learner controls.');
          preflight = applyCanvasCommands(preflight, compileMathCommand(m.visual, preflight, { ...m, title: content.title }));
        });
        for (const [index, moment] of content.moments.entries()) {
          if (item.order === this.lastOrder && index <= this.lastMoment) continue;
          // Missing or dropped sentences never count as played, even when later audio arrives.
          const played = started.get(item.utteranceId) ?? [];
          const eligible = item.utteranceId === '0' || content.moments.slice(0, index + 1)
            .every(m => played.includes(item.sentenceIdx + m.sentenceOffset));
          if (!eligible) continue;
          const commands = compileMathCommand(moment.visual, this.director.getSnapshot().canvas,
            { ...moment, title: content.title });
          const token = this.director.prepare({ id: `voice-${item.id}-${index}`, narration: content.title,
            cues: [{ id: `cue-${index}`, atMs: 0, commands }] });
          this.director.narrationStarted(token);
          this.lastOrder = item.order;
          this.lastMoment = index;
          this.error = null;
        }
      } catch (error) {
        this.failed.add(item.id);
        this.error = error instanceof Error ? error.message : 'Cannot show this picture.';
      }
    }
    const snapshot = this.director.getSnapshot();
    if (allowInteraction && snapshot.token) this.director.narrationEnded(snapshot.token);
  }

  interact(action: MathAction) {
    const token = this.director.getSnapshot().token;
    return this.allowInteraction && token ? this.director.interactMath(token, action) : null;
  }

  reset() {
    this.director.reset();
    this.lastOrder = -1;
    this.lastMoment = -1;
    this.knownIds.clear();
    this.failed.clear();
    this.error = null;
  }
}
