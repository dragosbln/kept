import { describe, expect, it } from 'vitest';
import { FakeEmbeddingClient, bagOfWordsVector } from './fake.js';

const cosineDistance = (a: number[], b: number[]): number =>
  1 - a.reduce((sum, value, index) => sum + value * (b[index] ?? 0), 0);

describe('FakeEmbeddingClient', () => {
  it('embeds the same words to the same unit vector, disjoint words to orthogonal ones', () => {
    const a = bagOfWordsVector('return shipping is free', 1536);
    const b = bagOfWordsVector('free return shipping IS', 1536);
    const c = bagOfWordsVector('holiday window extended', 1536);
    expect(cosineDistance(a, b)).toBeCloseTo(0, 6);
    expect(cosineDistance(a, c)).toBeCloseTo(1, 6);
    expect(Math.hypot(...a)).toBeCloseTo(1, 6);
  });

  it('returns one vector per input, records the call, and reports the configured model', async () => {
    const client = new FakeEmbeddingClient({ dimension: 16, model: 'fake-x' });
    const response = await client.embed(['a b', 'c']);
    expect(response.type).toBe('ok');
    if (response.type !== 'ok') return;
    expect(response.vectors).toHaveLength(2);
    expect(response.vectors[0]).toHaveLength(16);
    expect(client.calls).toEqual([['a b', 'c']]);
    expect(client.getConfig()).toEqual({ provider: 'openai', model: 'fake-x', dimension: 16 });
  });

  it('fails every call when asked to', async () => {
    const client = new FakeEmbeddingClient({ fail: 'timeout' });
    await expect(client.embed(['a'])).resolves.toMatchObject({
      type: 'transport_error',
      errorType: 'timeout',
    });
  });
});
