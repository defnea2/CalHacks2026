// UI copy and switches (pattern from the neoknow test client's app-config.ts).
export interface AppConfig {
  pageTitle: string;
  pageDescription: string;
  startButtonText: string;
  stopButtonText: string;
  headphonesHint: string;
  noisyHint: string;
  /** Default task text in the start form (test users only). */
  defaultTaskText: string;
  /** Photos are compressed to at most this many bytes before upload. */
  photoMaxBytes: number;
  photoMaxSide: number;
  /** Show the debug panel open by default (?debug=0 hides it). */
  debugOpen: boolean;
}

export const APP_CONFIG: AppConfig = {
  pageTitle: 'Fibonacci',
  pageDescription: 'Talk through a math problem with a friendly tutor.',
  startButtonText: 'Start talking',
  stopButtonText: 'Stop',
  headphonesHint: 'Tip: use headphones, so the tutor does not hear itself.',
  noisyHint: "It's loud here. Headphones or a quieter spot help.",
  defaultTaskText: '',
  photoMaxBytes: 1_000_000,
  photoMaxSide: 1600,
  debugOpen: true,
};
