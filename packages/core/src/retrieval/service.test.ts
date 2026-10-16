// The query pipeline of decision 3 and the verdict of decision 6, over a
// scripted repository: these pin what the service does with rows, not how
// the SQL finds them (that is pg/kb-repository.test.ts). Red until
// RetrievalService.retrieve is written (hand, block 2).

import { describe, expect, it } from 'vitest';
import { FakeEmbeddingClient, type FakeEmbeddingOptions } from './embedding/fake.js';
import { RetrievalError, RetrievalService, type RetrievalServiceOptions } from './service.js';
import { ScriptedKBRepository, distanceChunk, type ScriptedRows } from './testing.js';
import type {
  DistanceKBChunk,
  RetrievalScope,
  RetrieveFilterOptions,
  RetrieveKBChunksOptions,
} from './types.js';

const AS_OF = Date.UTC(2026, 8, 21);
const scope: RetrievalScope = { storeId: 'loomhaven', asOf: AS_OF };
const config = { topKBinding: 2, topKInformational: 1, maxDistance: 0.5 };
const QUESTION = 'is return shipping free';

function world(
  rows: ScriptedRows,
  clientOptions: FakeEmbeddingOptions = {},
  serviceOptions: RetrievalServiceOptions = {},
): { repo: ScriptedKBRepository; client: FakeEmbeddingClient; service: RetrievalService } {
  const repo = new ScriptedKBRepository(rows);
  const client = new FakeEmbeddingClient(clientOptions);
  return { repo, client, service: new RetrievalService(client, repo, config, serviceOptions) };
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

// The two retrieval toggles (block 4), pinned on what the service asks the
// repository, since the SQL is pg/kb-repository.test.ts's.
describe('RetrievalService.retrieve under fault toggles', () => {
  type Call = { options: RetrieveKBChunksOptions; filters: RetrieveFilterOptions };
  function callsOf(repo: ScriptedKBRepository): { bindingCall: Call; informationalCall: Call } {
    const at = (tier: 'binding' | 'informational'): Call => {
      const index = repo.calls.findIndex((call) => call.tiers.includes(tier));
      if (index < 0) throw new Error(`no ${tier} call`);
      return { options: repo.calls[index]!, filters: repo.filters[index]! };
    };
    return { bindingCall: at('binding'), informationalCall: at('informational') };
  }

  it('no toggle: both calls carry the store and no filters, the binding call carries asOf', async () => {
    const { repo, service } = world({});
    await service.retrieve(QUESTION, scope);
    const { bindingCall, informationalCall } = callsOf(repo);
    expect(bindingCall.options).toMatchObject({ storeId: 'loomhaven', asOf: AS_OF });
    expect(informationalCall.options).toMatchObject({ storeId: 'loomhaven' });
    expect(informationalCall.options.asOf).toBeUndefined();
    expect(bindingCall.filters.storeFilterOff).toBeFalsy();
    expect(informationalCall.filters.storeFilterOff).toBeFalsy();
  });

  it('retrieval-scope-off: both repository calls carry storeFilterOff', async () => {
    const { repo, service } = world({}, {}, { faultToggles: ['retrieval-scope-off'] });
    await service.retrieve(QUESTION, scope);
    const { bindingCall, informationalCall } = callsOf(repo);
    expect(bindingCall.filters).toEqual({ storeFilterOff: true });
    expect(informationalCall.filters).toEqual({ storeFilterOff: true });
    // The window is not this toggle's.
    expect(bindingCall.options.asOf).toBe(AS_OF);
  });

  it('stale-kb: the binding call is sent without asOf; the informational call is unchanged', async () => {
    const { repo, service } = world({}, {}, { faultToggles: ['stale-kb'] });
    await service.retrieve(QUESTION, scope);
    const { bindingCall, informationalCall } = callsOf(repo);
    expect(bindingCall.options.asOf).toBeUndefined();
    expect(bindingCall.options).toMatchObject({ storeId: 'loomhaven', tiers: ['binding'] });
    expect(bindingCall.filters.storeFilterOff).toBeFalsy();
    expect(informationalCall.options).toMatchObject({
      storeId: 'loomhaven',
      tiers: ['informational'],
      topK: config.topKInformational,
    });
    expect(informationalCall.options.asOf).toBeUndefined();
  });

  it('an unrelated toggle changes nothing about either call', async () => {
    const { repo, service } = world(
      {},
      {},
      { faultToggles: ['caps-per-call-only', 'swallow-tool-errors'] },
    );
    await service.retrieve(QUESTION, scope);
    const { bindingCall, informationalCall } = callsOf(repo);
    expect(bindingCall.options).toMatchObject({ storeId: 'loomhaven', asOf: AS_OF });
    expect(bindingCall.filters.storeFilterOff).toBeFalsy();
    expect(informationalCall.filters.storeFilterOff).toBeFalsy();
  });

  it('under retrieval-scope-off a binding chunk of another store still yields a grounded verdict', async () => {
    const leaked = distanceChunk({
      id: 'AV-RET@1#§3',
      tier: 'binding',
      distance: 0.1,
      storeId: 'averlane',
      docId: 'AV-RET',
      sectionRef: '§3',
    });
    const { service } = world({ binding: [leaked] }, {}, { faultToggles: ['retrieval-scope-off'] });
    const result = await service.retrieve(QUESTION, scope);
    expect(result.verdict).toBe('grounded');
    expect(result.chunks.map((chunk) => [chunk.docId, chunk.dropped])).toEqual([['AV-RET', false]]);
  });
});
