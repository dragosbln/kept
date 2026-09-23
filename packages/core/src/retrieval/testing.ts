// Test doubles for the retrieval core, exported so the agent app's tests can
// build a service that never searches. The scripted repository answers with
// canned rows per tier and records what it was asked, which is exactly what
// the service tests need: they pin the pipeline, not the SQL.

import { FakeEmbeddingClient } from './embedding/fake.js';
import { RetrievalService } from './service.js';
import type { DistanceKBChunk, KBChunk, KBRepository, RetrieveKBChunksOptions } from './types.js';

export type ScriptedRows = Partial<Record<DistanceKBChunk['tier'], DistanceKBChunk[]>>;

export class ScriptedKBRepository implements KBRepository {
  readonly calls: RetrieveKBChunksOptions[] = [];
  readonly upserted: KBChunk[] = [];
  /** When set, retrieve() rejects with it: the repository_failed path. */
  failWith: Error | undefined;

  constructor(
    private readonly rows: ScriptedRows = {},
    private readonly models: string[] = [],
  ) {}

  async retrieve(options: RetrieveKBChunksOptions): Promise<DistanceKBChunk[]> {
    this.calls.push(options);
    if (this.failWith) throw this.failWith;
    const matching = options.tiers.flatMap((tier) => this.rows[tier] ?? []);
    return matching.toSorted((a, b) => a.distance - b.distance).slice(0, options.topK);
  }

  async upsertBatch(chunks: KBChunk[]): Promise<void> {
    this.upserted.push(...chunks);
  }

  async getEmbeddingModelsForStore(): Promise<string[]> {
    return [...this.models];
  }

  async deleteStore(): Promise<number> {
    const count = this.upserted.length;
    this.upserted.length = 0;
    return count;
  }
}

/** A stored chunk with distance, all fields defaulted, for scripting a repository. */
export function distanceChunk(
  overrides: Pick<DistanceKBChunk, 'id' | 'tier' | 'distance'> & Partial<DistanceKBChunk>,
): DistanceKBChunk {
  return {
    storeId: 'loomhaven',
    docId: 'LH-RET',
    docTitle: 'Loomhaven Apparel Co. — Return & Refund Policy',
    sectionRef: '§1',
    version: '1.2',
    effectiveFrom: overrides.tier === 'binding' ? Date.UTC(2026, 2, 1) : null,
    effectiveTo: null,
    text: `text of ${overrides.id}`,
    embeddingModel: 'fake-bag-of-words',
    ...overrides,
  };
}

/** A service over a fake client and an empty scripted repository, for tests that never call search_policy. */
export function stubRetrievalService(): RetrievalService {
  return new RetrievalService(new FakeEmbeddingClient(), new ScriptedKBRepository());
}
