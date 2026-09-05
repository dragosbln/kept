// Unit tests for the code-shipped PromptManager. The load-bearing property
// is the hash contract: always computed from the exact text, never stored,
// so a trace's promptHash can never disagree with the text that produced it.

import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { CodePromptManager } from './code-prompt-manager.js';
import type { PromptRegistry } from './types.js';

const registry: PromptRegistry = {
  'main-agent': {
    '1.0.0': 'You are a post-purchase support agent.',
    '1.1.0': 'You are a post-purchase support agent. Be concise.',
  },
};

describe('CodePromptManager', () => {
  it('returns the requested prompt with name and version passed through', async () => {
    const manager = new CodePromptManager(registry);
    const data = await manager.getVersionedPromptData('main-agent', '1.0.0');
    expect(data).toMatchObject({
      name: 'main-agent',
      version: '1.0.0',
      text: 'You are a post-purchase support agent.',
    });
  });

  it('hashes the exact text with SHA-256, hex-encoded', async () => {
    const manager = new CodePromptManager(registry);
    const data = await manager.getVersionedPromptData('main-agent', '1.0.0');
    const expected = createHash('sha256')
      .update('You are a post-purchase support agent.')
      .digest('hex');
    expect(data.hash).toBe(expected);
  });

  it('is deterministic: same version yields the same hash across calls', async () => {
    const manager = new CodePromptManager(registry);
    const first = await manager.getVersionedPromptData('main-agent', '1.0.0');
    const second = await manager.getVersionedPromptData('main-agent', '1.0.0');
    expect(second.hash).toBe(first.hash);
  });

  it('different text yields a different hash, whatever the version labels claim', async () => {
    const manager = new CodePromptManager(registry);
    const v1 = await manager.getVersionedPromptData('main-agent', '1.0.0');
    const v11 = await manager.getVersionedPromptData('main-agent', '1.1.0');
    expect(v11.hash).not.toBe(v1.hash);
  });

  it('throws for an unknown version, naming both prompt and version', async () => {
    const manager = new CodePromptManager(registry);
    // Unknown *names* are unrepresentable: PromptName is a closed union,
    // so only the version axis can miss at runtime.
    await expect(manager.getVersionedPromptData('main-agent', '9.9.9')).rejects.toThrow(
      /main-agent.*9\.9\.9/,
    );
  });

  it('defaults to the shipped registry when none is injected', async () => {
    const manager = new CodePromptManager();
    const data = await manager.getVersionedPromptData('main-agent', '1.0.0');
    expect(data.text.length).toBeGreaterThan(0);
    expect(data.hash).toMatch(/^[0-9a-f]{64}$/);
  });
});
