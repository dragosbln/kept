// configFromEnv: the provider follows the one key present, each provider
// has its own model and token-budget defaults, and every ambiguous or
// incomplete setup is a boot-time refusal that names the fix.

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_POLICY_CONFIG, hashPolicyConfig } from '@kept-hq/core';
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

describe('KEPT_POLICY_CONFIG', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'kept-policy-'));
  const write = (name: string, body: string): string => {
    const file = path.join(dir, name);
    writeFileSync(file, body);
    return file;
  };
  const env = { OPENAI_API_KEY: 'o' };

  it('unset means the built-in defaults', () => {
    expect(configFromEnv(env)).not.toHaveProperty('policy');
    expect(configFromEnv({ ...env, KEPT_POLICY_CONFIG: '  ' })).not.toHaveProperty('policy');
  });

  it('loads, validates and hashes the file; relative paths resolve from INIT_CWD', () => {
    const file = write(
      'policy.json',
      JSON.stringify({
        version: '2.0.0',
        caps: [{ kind: 'per_call', amountMinorUnits: 5000, currency: 'USD' }],
      }),
    );
    const absolute = configFromEnv({ ...env, KEPT_POLICY_CONFIG: file });
    expect(absolute.policy).toMatchObject({ source: file, config: { version: '2.0.0' } });
    expect(absolute.policy?.hash).toBe(hashPolicyConfig(absolute.policy!.config));

    const relative = configFromEnv({ ...env, KEPT_POLICY_CONFIG: 'policy.json', INIT_CWD: dir });
    expect(relative.policy?.source).toBe(file);
  });

  it('the shipped example is valid and equals the built-in defaults', () => {
    const example = path.resolve(import.meta.dirname, '../../../config/policy.example.json');
    const config = configFromEnv({ ...env, KEPT_POLICY_CONFIG: example });
    expect(config.policy?.hash).toBe(hashPolicyConfig(DEFAULT_POLICY_CONFIG));
  });

  it('refuses a missing file, invalid JSON, and a config the schema rejects, naming the variable', () => {
    expect(() =>
      configFromEnv({ ...env, KEPT_POLICY_CONFIG: path.join(dir, 'nope.json') }),
    ).toThrow(/KEPT_POLICY_CONFIG: no file/);
    const bad = write('bad.json', '{ not json');
    expect(() => configFromEnv({ ...env, KEPT_POLICY_CONFIG: bad })).toThrow(/not valid JSON/);
    // A windowed kind without its window is the schema's own refusal.
    const wrong = write(
      'wrong.json',
      JSON.stringify({
        version: '1',
        caps: [{ kind: 'per_day', amountMinorUnits: 1, currency: 'USD' }],
      }),
    );
    expect(() => configFromEnv({ ...env, KEPT_POLICY_CONFIG: wrong })).toThrow(/schema/);
  });
});
