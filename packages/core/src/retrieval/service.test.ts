// The query pipeline of decision 3 and the verdict of decision 6, over a
// scripted repository: these pin what the service does with rows, not how
// the SQL finds them (that is pg/kb-repository.test.ts). Red until
// RetrievalService.retrieve is written (hand, block 2).

import { describe, expect, it } from 'vitest';
import { FakeEmbeddingClient, type FakeEmbeddingOptions } from './embedding/fake.js';
import { RetrievalError, RetrievalService } from './service.js';
import { ScriptedKBRepository, distanceChunk, type ScriptedRows } from './testing.js';
import type { DistanceKBChunk, RetrievalScope } from './types.js';

const AS_OF = Date.UTC(2026, 8, 21);
const scope: RetrievalScope = { storeId: 'loomhaven', asOf: AS_OF };
const config = { topKBinding: 2, topKInformational: 1, maxDistance: 0.5 };
const QUESTION = 'is return shipping free';

function world(
  rows: ScriptedRows,
  clientOptions: FakeEmbeddingOptions = {},
): { repo: ScriptedKBRepository; client: FakeEmbeddingClient; service: RetrievalService } {
  const repo = new ScriptedKBRepository(rows);
  const client = new FakeEmbeddingClient(clientOptions);
  return { repo, client, service: new RetrievalService(client, repo, config) };
}

const binding = (id: string, distance: number): DistanceKBChunk =>
  distanceChunk({ id, tier: 'binding', distance });
const article = (id: string, distance: number): DistanceKBChunk =>
  distanceChunk({ id, tier: 'informational', distance, docId: 'HC-LH-05', sectionRef: 'HC-LH-05' });

describe('RetrievalService.retrieve', () => {
  it('embeds the question once, as a one-element batch', async () => {
    const { client, service } = world({ binding: [binding('b1', 0.1)] });
    await service.retrieve(QUESTION, scope);
    expect(client.calls).toEqual([[QUESTION]]);
  });

  it('queries binding chunks under the clock and informational chunks without it (decision 6)', async () => {
    const { repo, service } = world({});
    await service.retrieve(QUESTION, scope);
    const bindingCall = repo.calls.find((call) => call.tiers.includes('binding'));
    const articleCall = repo.calls.find((call) => call.tiers.includes('informational'));
    expect(bindingCall).toMatchObject({
      storeId: 'loomhaven',
      tiers: ['binding'],
      asOf: AS_OF,
      topK: config.topKBinding,
    });
    expect(articleCall).toMatchObject({
      storeId: 'loomhaven',
      tiers: ['informational'],
      topK: config.topKInformational,
    });
    expect(articleCall?.asOf).toBeUndefined();
    expect(bindingCall?.queryVector).toHaveLength(64);
  });

  it('grounded: a binding chunk cleared, informational alongside, binding first', async () => {
    const { service } = world({
      binding: [binding('b1', 0.2)],
      informational: [article('a1', 0.1)],
    });
    const result = await service.retrieve(QUESTION, scope);
    expect(result.verdict).toBe('grounded');
    expect(result.chunks.map((chunk) => chunk.id)).toEqual(['b1', 'a1']);
    expect(result.chunks.every((chunk) => !chunk.dropped)).toBe(true);
    expect(result.chunks[0]).toMatchObject({
      docId: 'LH-RET',
      sectionRef: '§1',
      tier: 'binding',
      distance: 0.2,
      effectiveFrom: Date.UTC(2026, 2, 1),
      effectiveTo: null,
    });
  });

  it('marks chunks past the threshold dropped and keeps them in the result (decision 3)', async () => {
    const { service } = world({ binding: [binding('near', 0.2), binding('far', 0.9)] });
    const result = await service.retrieve(QUESTION, scope);
    expect(result.verdict).toBe('grounded');
    expect(result.chunks.map((chunk) => [chunk.id, chunk.dropped])).toEqual([
      ['near', false],
      ['far', true],
    ]);
  });

  it('informational_only: every binding chunk dropped, an article cleared', async () => {
    const { service } = world({
      binding: [binding('b1', 0.8)],
      informational: [article('a1', 0.1)],
    });
    const result = await service.retrieve(QUESTION, scope);
    expect(result.verdict).toBe('informational_only');
    expect(result.chunks).toHaveLength(2);
  });

  it('no_match: nothing cleared, and nothing retrieved at all', async () => {
    const dropped = world({ binding: [binding('b1', 0.8)], informational: [article('a1', 0.7)] });
    const nothing = world({});
    await expect(dropped.service.retrieve(QUESTION, scope)).resolves.toMatchObject({
      verdict: 'no_match',
    });
    const empty = await nothing.service.retrieve(QUESTION, scope);
    expect(empty).toEqual({ verdict: 'no_match', chunks: [] });
  });

  it('orders binding before informational, and by distance within a tier', async () => {
    const { service } = world({
      binding: [binding('b-far', 0.4), binding('b-near', 0.1)],
      informational: [article('a-nearest', 0.05)],
    });
    const result = await service.retrieve(QUESTION, scope);
    expect(result.chunks.map((chunk) => chunk.id)).toEqual(['b-near', 'b-far', 'a-nearest']);
  });

  it('an embedding transport error becomes RetrievalError(embedding_failed)', async () => {
    const { service } = world({ binding: [binding('b1', 0.1)] }, { fail: 'timeout' });
    await expect(service.retrieve(QUESTION, scope)).rejects.toBeInstanceOf(RetrievalError);
    await expect(service.retrieve(QUESTION, scope)).rejects.toMatchObject({
      kind: 'embedding_failed',
    });
  });

  it('a repository throw becomes RetrievalError(repository_failed)', async () => {
    const { repo, service } = world({ binding: [binding('b1', 0.1)] });
    repo.failWith = new Error('connection reset');
    await expect(service.retrieve(QUESTION, scope)).rejects.toMatchObject({
      kind: 'repository_failed',
    });
  });
});
