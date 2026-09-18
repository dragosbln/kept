// configFromEnv: the provider follows the one key present, each provider
// has its own model and token-budget defaults, and every ambiguous or
// incomplete setup is a boot-time refusal that names the fix.

import { describe, expect, it } from 'vitest';
import { PROVIDER_DEFAULTS, configFromEnv } from './handler.js';

describe('configFromEnv', () => {
  it('one key selects its provider with that provider’s defaults', () => {
    const anthropic = configFromEnv({ ANTHROPIC_API_KEY: 'sk-ant-test' });
    expect(anthropic).toMatchObject({
      provider: 'anthropic',
      apiKey: 'sk-ant-test',
      ...PROVIDER_DEFAULTS.anthropic,
    });

    const openai = configFromEnv({ OPENAI_API_KEY: 'sk-openai-test' });
    expect(openai).toMatchObject({
      provider: 'openai',
      apiKey: 'sk-openai-test',
      ...PROVIDER_DEFAULTS.openai,
    });
    expect(PROVIDER_DEFAULTS.openai.model).not.toBe(PROVIDER_DEFAULTS.anthropic.model);
  });

  it('KEPT_PROVIDER decides when both keys are set; without it that is a refusal', () => {
    const both = { ANTHROPIC_API_KEY: 'a', OPENAI_API_KEY: 'o' };
    expect(() => configFromEnv(both)).toThrow(/KEPT_PROVIDER/);
    expect(configFromEnv({ ...both, KEPT_PROVIDER: 'openai' })).toMatchObject({
      provider: 'openai',
      apiKey: 'o',
    });
    expect(configFromEnv({ ...both, KEPT_PROVIDER: 'anthropic' })).toMatchObject({
      provider: 'anthropic',
      apiKey: 'a',
    });
  });

  it('refuses a missing key, a provider without its key, and an unknown provider', () => {
    expect(() => configFromEnv({})).toThrow(/ANTHROPIC_API_KEY or OPENAI_API_KEY/);
    expect(() => configFromEnv({ KEPT_PROVIDER: 'openai', ANTHROPIC_API_KEY: 'a' })).toThrow(
      /OPENAI_API_KEY/,
    );
    expect(() => configFromEnv({ KEPT_PROVIDER: 'mistral', OPENAI_API_KEY: 'o' })).toThrow(
      /KEPT_PROVIDER/,
    );
  });

  it('the OpenAI reasoning field follows KEPT_OPENAI_REASONING_EFFORT: provider default, cleared, set, refused', () => {
    const openai = { OPENAI_API_KEY: 'o' };
    // The default model refuses tools unless reasoning is off, so off is the default.
    expect(PROVIDER_DEFAULTS.openai.reasoningEffort).toBe('none');
    expect(configFromEnv(openai).reasoningEffort).toBe('none');
    // Emptied for models without reasoning, which reject the field.
    expect(configFromEnv({ ...openai, KEPT_OPENAI_REASONING_EFFORT: '' })).not.toHaveProperty(
      'reasoningEffort',
    );
    expect(
      configFromEnv({ ...openai, KEPT_OPENAI_REASONING_EFFORT: 'minimal' }).reasoningEffort,
    ).toBe('minimal');
    expect(() => configFromEnv({ ...openai, KEPT_OPENAI_REASONING_EFFORT: 'turbo' })).toThrow(
      /KEPT_OPENAI_REASONING_EFFORT/,
    );
    // Anthropic never carries the field, whatever the variable says.
    expect(
      configFromEnv({ ANTHROPIC_API_KEY: 'a', KEPT_OPENAI_REASONING_EFFORT: 'high' }),
    ).not.toHaveProperty('reasoningEffort');
  });

  it('explicit model and token budget override the provider defaults', () => {
    const config = configFromEnv({
      OPENAI_API_KEY: 'o',
      KEPT_MODEL: 'gpt-5.6-luna',
      KEPT_MAX_TOKENS: '2048',
    });
    expect(config).toMatchObject({ provider: 'openai', model: 'gpt-5.6-luna', maxTokens: 2048 });
  });
});
