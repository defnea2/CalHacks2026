// Picks the LLM provider from config: Anthropic (default when ANTHROPIC_API_KEY is set) or OpenRouter.
import type { LlmProvider } from '@tutor/shared';
import { AnthropicProvider } from './anthropic';
import type { WorkerConfig } from './env';
import { OpenRouterProvider } from './llm';

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
