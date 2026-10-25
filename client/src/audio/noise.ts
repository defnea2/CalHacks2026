// Noise detection (spec "Noise detection"). Pure, driven per VAD frame.
//
// 1. Every frame's RMS level in dBFS comes in with its speech probability.
// 2. Noise floor: moving average of the level over frames with probability < 0.3
//    (exponential, time constant NOISE_FLOOR_TAU_MS). The first NOISE_SEED_MS seed it with a plain mean.
// 3. Energy gate: speech may only start when the level is >= floor + NOISE_SNR_DB.
// 4. State from the floor: quiet < NOISE_QUIET_DBFS <= moderate <= NOISE_NOISY_DBFS < noisy.

export type NoiseState = 'quiet' | 'moderate' | 'noisy';

export interface NoiseConfig {
  NOISE_SNR_DB: number;
  NOISE_QUIET_DBFS: number;
  NOISE_NOISY_DBFS: number;
  NOISE_FLOOR_TAU_MS: number;
  NOISE_SEED_MS: number;
  /** Frames below this probability feed the floor (spec: 0.3). */
  NOISE_FLOOR_MAX_PROB: number;
}

export function noiseStateFor(floorDb: number, cfg: Pick<NoiseConfig, 'NOISE_QUIET_DBFS' | 'NOISE_NOISY_DBFS'>): NoiseState {
  if (floorDb < cfg.NOISE_QUIET_DBFS) return 'quiet';
  if (floorDb > cfg.NOISE_NOISY_DBFS) return 'noisy';
  return 'moderate';
}

export class NoiseMonitor {
  /** Current floor in dBFS; null until the first eligible frame. */
  floorDb: number | null = null;
  private elapsedMs = 0;
  private seedSum = 0;
  private seedCount = 0;

  constructor(private readonly cfg: NoiseConfig) {}

  /** Feed one frame. Returns the floor after the update. */
  update(levelDb: number, prob: number, frameMs: number): number | null {
    this.elapsedMs += frameMs;
    if (prob < this.cfg.NOISE_FLOOR_MAX_PROB) {
      if (this.elapsedMs <= this.cfg.NOISE_SEED_MS || this.floorDb === null) {
        // Seeding: plain mean of the quiet frames seen so far.
        this.seedSum += levelDb;
        this.seedCount += 1;
        this.floorDb = this.seedSum / this.seedCount;
      } else {
        const alpha = 1 - Math.exp(-frameMs / this.cfg.NOISE_FLOOR_TAU_MS);
        this.floorDb = this.floorDb + alpha * (levelDb - this.floorDb);
      }
    }
    return this.floorDb;
  }

  get seeded(): boolean {
    return this.elapsedMs >= this.cfg.NOISE_SEED_MS;
  }

  /** Energy gate for starting speech. Without a floor yet, the gate is open. */
  passesGate(levelDb: number): boolean {
    if (this.floorDb === null) return true;
    return levelDb >= this.floorDb + this.cfg.NOISE_SNR_DB;
  }

  get state(): NoiseState {
    return this.floorDb === null ? 'quiet' : noiseStateFor(this.floorDb, this.cfg);
  }
}
