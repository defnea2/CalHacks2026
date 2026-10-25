// Picks the LLM provider from config: Anthropic (default when ANTHROPIC_API_KEY is set) or OpenRouter.
import type { LlmProvider } from '@tutor/shared';
import { AnthropicProvider } from './anthropic';
import type { WorkerConfig } from './env';
import { OpenRouterProvider } from './llm';

/** Lesson-mode LLM: same provider, thinking off (team: adaptive thinking added ~8 s), own effort. */
export function createLessonLlm(cfg: WorkerConfig): LlmProvider {
  if (cfg.llmProvider === 'anthropic')
    return new AnthropicProvider({ apiKey: cfg.anthropicApiKey, model: cfg.anthropicModel, effort: cfg.lessonEffort, thinking: 'disabled', maxTokens: 4000 });
  return createLlm(cfg).llm;
}

export function createLlm(cfg: WorkerConfig): { llm: LlmProvider; info: string } {
  if (cfg.llmProvider === 'anthropic') {
    return {
      llm: new AnthropicProvider({ apiKey: cfg.anthropicApiKey, model: cfg.anthropicModel, effort: cfg.anthropicEffort, thinking: cfg.anthropicThinking }),
      info: `anthropic ${cfg.anthropicModel}, effort ${cfg.anthropicEffort}, thinking ${cfg.anthropicThinking}`,
    };
  }
  return {
    llm: new OpenRouterProvider({ apiKey: cfg.openrouterApiKey, model: cfg.openrouterModel, reasoningEffort: cfg.reasoningEffort }),
    info: `openrouter ${cfg.openrouterModel}, reasoning ${cfg.reasoningEffort || 'default'}`,
  };
}
