// Keeps the AudioContext running: resume() on every audio push and on any pointerdown (a user
// gesture lets the browser unlock it). If it is still not running after BLOCKED_AFTER_MS, the UI
// shows a "Tap for sound" hint; it hides again as soon as the context runs.

export const AUDIO_BLOCKED_AFTER_MS = 1000;

type Ctx = Pick<AudioContext, 'state' | 'resume'> & { onstatechange: ((this: AudioContext, ev: Event) => unknown) | null };

export class AudioUnlock {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private blocked = false;
  private readonly onPointer = () => this.poke();

  constructor(
    private readonly ctx: Ctx,
    private readonly onBlocked: (blocked: boolean) => void,
    private readonly target: Pick<EventTarget, 'addEventListener' | 'removeEventListener'> | null = typeof window !== 'undefined' ? window : null
  ) {
    this.target?.addEventListener('pointerdown', this.onPointer, { capture: true });
    ctx.onstatechange = () => {
      if (this.ctx.state === 'running') this.set(false);
    };
  }

  /** Try to (re)start the context; report it as blocked if it does not run soon. */
  poke(): void {
    if (this.ctx.state === 'running') return this.set(false);
    if (this.ctx.state === 'closed') return;
    void this.ctx.resume().catch(() => {});
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.set(this.ctx.state !== 'running' && this.ctx.state !== 'closed');
    }, AUDIO_BLOCKED_AFTER_MS);
  }

  destroy(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    this.target?.removeEventListener('pointerdown', this.onPointer, { capture: true });
    this.ctx.onstatechange = null;
    this.set(false);
  }

  private set(blocked: boolean): void {
    if (blocked === this.blocked) return;
    this.blocked = blocked;
    this.onBlocked(blocked);
  }
}
