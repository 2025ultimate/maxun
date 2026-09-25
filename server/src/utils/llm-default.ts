/**
 * Server-wide default LLM provider, overridable via env.
 * Set DEFAULT_LLM_PROVIDER=openai plus OPENAI_BASE_URL/OPENAI_API_KEY (or the
 * Fireworks equivalents) to make every robot default to Fireworks without
 * per-robot config.
 */
export const FIREWORKS_BASE_URL = 'https://api.fireworks.ai/inference/v1';

export type DefaultProvider = 'anthropic' | 'openai' | 'ollama';

export function defaultLlmProvider(): DefaultProvider {
  const v = (process.env.DEFAULT_LLM_PROVIDER || '').trim().toLowerCase();
  if (v === 'anthropic' || v === 'openai' || v === 'ollama') return v;
  return 'ollama';
}

/**
 * Resolve the effective LLM config, applying Fireworks defaults when the
 * operator has pointed the default OpenAI-compatible endpoint at Fireworks.
 */
export function applyDefaultLlmEnv(config: {
  provider: string;
  model?: string;
  apiKey?: string;
  baseUrl?: string;
}): { provider: DefaultProvider; model?: string; apiKey?: string; baseUrl?: string } {
  let provider = (config.provider || defaultLlmProvider()) as DefaultProvider;
  let model = config.model;
  let baseUrl = config.baseUrl;
  let apiKey = config.apiKey;

  if (provider === 'openai') {
    // Default the OpenAI-compatible endpoint to Fireworks when configured.
    if (!baseUrl) {
      baseUrl = process.env.FIREWORKS_BASE_URL || process.env.OPENAI_BASE_URL || undefined;
    }
    if (!model) {
      model = process.env.FIREWORKS_MODEL || undefined;
    }
    if (!apiKey) {
      apiKey = process.env.FIREWORKS_API_KEY || undefined;
    }
  }

  return { provider, model, apiKey, baseUrl };
}
