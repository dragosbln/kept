// Against the compose Postgres (DATABASE_URL), the way the eval suite runs:
// Postgres alone, no Langfuse (ADR 0001). Skipped without DATABASE_URL so a
// clean clone's `pnpm test` stays green; run with
//   DATABASE_URL=postgresql://kept:kept@localhost:5432/kept pnpm --filter @kept-hq/core test
// Every run uses its own store ids and deletes them after, so the demo
// corpus in the same database is never touched.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FakeEmbeddingClient } from '../embedding/fake.js';
import type { KBChunk, KBChunkTier } from '../types.js';
import { createDb, type DbHandle } from './db.js';
import { PgKBRepository } from './kb-repository.js';
import { migrateDb } from './migrate.js';
import { EMBEDDING_DIMENSION } from './schema.js';

const DATABASE_URL = process.env['DATABASE_URL'];
const MODEL = 'fake-bag-of-words';
const AS_OF = Date.UTC(2026, 8, 21);

const embed = new FakeEmbeddingClient({ dimension: EMBEDDING_DIMENSION, model: MODEL });

async function vectorFor(text: string): Promise<number[]> {
  const response = await embed.embed([text]);
  if (response.type !== 'ok') throw new Error('fake client cannot fail');
  return response.vectors[0]!;
}

type ChunkSpec = {
  id: string;
  storeId: string;
  tier: KBChunkTier;
  text: string;
  effectiveFrom?: number | null;
  effectiveTo?: number | null;
  embeddingModel?: string;
};

async function chunk(spec: ChunkSpec): Promise<KBChunk> {
  return {
    id: spec.id,
    storeId: spec.storeId,
    docId: spec.id.split('#')[0] ?? spec.id,
    docTitle: `Doc ${spec.id}`,
    sectionRef: spec.id.split('#')[1] ?? spec.id,
    tier: spec.tier,
    version: '1',
    effectiveFrom: spec.effectiveFrom ?? (spec.tier === 'binding' ? Date.UTC(2026, 2, 1) : null),
    effectiveTo: spec.effectiveTo ?? null,
    text: spec.text,
    embedding: await vectorFor(spec.text),
    embeddingModel: spec.embeddingModel ?? MODEL,
  };
}

describe.skipIf(!DATABASE_URL)('PgKBRepository (Postgres from compose)', () => {
  const store = `test-${randomUUID()}`;
  const otherStore = `${store}-other`;
  const scratchStore = `${store}-scratch`;
  let handle: DbHandle;
  let repo: PgKBRepository;

  beforeAll(async () => {
    await migrateDb(DATABASE_URL!);
    handle = createDb(DATABASE_URL!, { max: 2 });
    repo = new PgKBRepository(handle.db);
  });

  afterAll(async () => {
    await repo.deleteStore(store);
    await repo.deleteStore(otherStore);
    await repo.deleteStore(scratchStore);
    await handle.close();
  });

  it('upserts by id: the same chunks twice leave one row each, with the newer text', async () => {
    const first = await chunk({
      id: 'S@1#§1',
      storeId: scratchStore,
      tier: 'binding',
      text: 'one',
    });
    const second = await chunk({
      id: 'S@1#§2',
      storeId: scratchStore,
      tier: 'binding',
      text: 'two',
    });
    await repo.upsertBatch([first, second]);
    await repo.upsertBatch([{ ...first, text: 'one, revised' }, second]);
    expect(await repo.deleteStore(scratchStore)).toBe(2);
  });

  it("the same chunk id in two stores is two rows: one store's ingest never touches another's", async () => {
    const twin = `${scratchStore}-twin`;
    await repo.upsertBatch([
      await chunk({ id: 'T@1#§1', storeId: scratchStore, tier: 'binding', text: 'one' }),
    ]);
    await repo.upsertBatch([
      await chunk({ id: 'T@1#§1', storeId: twin, tier: 'binding', text: 'one, elsewhere' }),
    ]);
    expect(await repo.getEmbeddingModelsForStore(scratchStore)).toEqual([MODEL]);
    expect(await repo.deleteStore(twin)).toBe(1);
    expect(await repo.deleteStore(scratchStore)).toBe(1);
  });

  it('lists the distinct embedding models of a store, and nothing for an unknown store', async () => {
    await repo.upsertBatch([
      await chunk({
        id: 'M@1#a',
        storeId: scratchStore,
        tier: 'binding',
        text: 'a',
        embeddingModel: 'm-b',
      }),
      await chunk({
        id: 'M@1#b',
        storeId: scratchStore,
        tier: 'binding',
        text: 'b',
        embeddingModel: 'm-a',
      }),
      await chunk({
        id: 'M@1#c',
        storeId: scratchStore,
        tier: 'binding',
        text: 'c',
        embeddingModel: 'm-a',
      }),
    ]);
    expect((await repo.getEmbeddingModelsForStore(scratchStore)).toSorted()).toEqual([
      'm-a',
      'm-b',
    ]);
    expect(await repo.getEmbeddingModelsForStore(`${scratchStore}-nothing`)).toEqual([]);
    await repo.deleteStore(scratchStore);
  });

  describe('retrieve (hand-written query, decision 3)', () => {
    const WINDOW = 'items may be returned within thirty days of delivery';
    const ADDENDUM =
      'holiday returns extended until january for orders placed in november and december';
    const FUTURE = 'a future policy that is not yet in force';
    const ARTICLE = 'returns at loomhaven are always free with a prepaid label';

    beforeAll(async () => {
      await repo.upsertBatch([
        await chunk({ id: 'RET@1#§2', storeId: store, tier: 'binding', text: WINDOW }),
        await chunk({
          id: 'HOL@1#§1',
          storeId: store,
          tier: 'binding',
          text: ADDENDUM,
          effectiveFrom: Date.UTC(2025, 10, 1),
          effectiveTo: Date.UTC(2026, 1, 1),
        }),
        await chunk({
          id: 'FUT@1#§1',
          storeId: store,
          tier: 'binding',
          text: FUTURE,
          effectiveFrom: Date.UTC(2027, 0, 1),
        }),
        await chunk({ id: 'HC@undated#HC', storeId: store, tier: 'informational', text: ARTICLE }),
        await chunk({ id: 'OTHER@1#§2', storeId: otherStore, tier: 'binding', text: WINDOW }),
      ]);
    });

    it('scopes to the store', async () => {
      const rows = await repo.retrieve({
        storeId: store,
        tiers: ['binding', 'informational'],
        queryVector: await vectorFor(WINDOW),
        topK: 10,
      });
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every((row) => row.storeId === store)).toBe(true);
      expect(rows.map((row) => row.id)).not.toContain('OTHER@1#§2');
    });

    it('filters by tier', async () => {
      const rows = await repo.retrieve({
        storeId: store,
        tiers: ['informational'],
        queryVector: await vectorFor(WINDOW),
        topK: 10,
      });
      expect(rows.map((row) => row.id)).toEqual(['HC@undated#HC']);
    });

    it('applies the effective-date window when asOf is given', async () => {
      const rows = await repo.retrieve({
        storeId: store,
        tiers: ['binding'],
        asOf: AS_OF,
        queryVector: await vectorFor(WINDOW),
        topK: 10,
      });
      const ids = rows.map((row) => row.id);
      expect(ids).toContain('RET@1#§2');
      expect(ids).not.toContain('HOL@1#§1');
      expect(ids).not.toContain('FUT@1#§1');
    });

    it('includes expired and future documents when asOf is absent (what stale-KB will exploit)', async () => {
      const rows = await repo.retrieve({
        storeId: store,
        tiers: ['binding'],
        queryVector: await vectorFor(ADDENDUM),
        topK: 10,
      });
      expect(rows.map((row) => row.id)).toContain('HOL@1#§1');
    });

    it('ranks by cosine distance, nearest first, and honours topK', async () => {
      const ranked = await repo.retrieve({
        storeId: store,
        tiers: ['binding', 'informational'],
        queryVector: await vectorFor(ARTICLE),
        topK: 10,
      });
      expect(ranked[0]?.id).toBe('HC@undated#HC');
      expect(ranked[0]?.distance).toBeCloseTo(0, 5);
      for (let index = 1; index < ranked.length; index += 1) {
        expect(ranked[index]!.distance).toBeGreaterThanOrEqual(ranked[index - 1]!.distance);
      }
      const one = await repo.retrieve({
        storeId: store,
        tiers: ['binding', 'informational'],
        queryVector: await vectorFor(ARTICLE),
        topK: 1,
      });
      expect(one).toHaveLength(1);
    });

    it('returns the row without its embedding', async () => {
      const [row] = await repo.retrieve({
        storeId: store,
        tiers: ['informational'],
        queryVector: await vectorFor(ARTICLE),
        topK: 1,
      });
      expect(row).toMatchObject({
        id: 'HC@undated#HC',
        docId: 'HC@undated',
        sectionRef: 'HC',
        tier: 'informational',
        effectiveFrom: null,
        effectiveTo: null,
        embeddingModel: MODEL,
      });
      expect(row).not.toHaveProperty('embedding');
    });
  });
});
