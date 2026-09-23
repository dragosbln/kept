// Ingestion over the real fixture corpus into the compose Postgres, with the
// fake embedding client (no network). Skipped without DATABASE_URL; red
// until chunkDocument is written (hand, block 2). Store ids are remapped
// per run so the demo corpus in the same database is never touched.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EmbeddingModelCheckError } from './boot.js';
import { FakeEmbeddingClient } from './embedding/fake.js';
import { loadPolicyDocuments } from './fixtures/loader.js';
import { ingestDocuments, kbChunkId } from './ingest.js';
import { createDb, type DbHandle } from './pg/db.js';
import { PgKBRepository } from './pg/kb-repository.js';
import { migrateDb } from './pg/migrate.js';
import { EMBEDDING_DIMENSION } from './pg/schema.js';
import type { SourceDocument } from './source-document.js';

const DATABASE_URL = process.env['DATABASE_URL'];

describe('kbChunkId', () => {
  it('is the document, its version and the section', () => {
    expect(kbChunkId({ docId: 'LH-RET', version: '1.2', sectionRef: '§6' })).toBe('LH-RET@1.2#§6');
  });
});

describe.skipIf(!DATABASE_URL)('ingestDocuments over the fixture corpus', () => {
  const runId = randomUUID().slice(0, 8);
  const storeOf = (storeId: string): string => `${storeId}-${runId}`;
  let handle: DbHandle;
  let repo: PgKBRepository;
  let docs: SourceDocument[];
  const client = new FakeEmbeddingClient({
    dimension: EMBEDDING_DIMENSION,
    model: 'fake-bag-of-words',
  });

  beforeAll(async () => {
    await migrateDb(DATABASE_URL!);
    handle = createDb(DATABASE_URL!, { max: 2 });
    repo = new PgKBRepository(handle.db);
    docs = (await loadPolicyDocuments()).map((doc) =>
      Object.assign({}, doc, { storeId: storeOf(doc.storeId) }),
    );
  });

  afterAll(async () => {
    await repo.deleteStore(storeOf('loomhaven'));
    await repo.deleteStore(storeOf('averlane'));
    await handle.close();
  });

  it('loads the corpus once, and a second run changes nothing', async () => {
    const first = await ingestDocuments(docs, { embeddingClient: client, kbRepo: repo });
    expect(first).toEqual({
      documents: 20,
      chunks: 71,
      chunksByStore: { [storeOf('loomhaven')]: 32, [storeOf('averlane')]: 39 },
    });
    const second = await ingestDocuments(docs, { embeddingClient: client, kbRepo: repo });
    expect(second).toEqual(first);
    expect(await repo.getEmbeddingModelsForStore(storeOf('loomhaven'))).toEqual([
      'fake-bag-of-words',
    ]);
  });

  it('refuses to add chunks under a different embedding model', async () => {
    const other = new FakeEmbeddingClient({ dimension: EMBEDDING_DIMENSION, model: 'other-model' });
    await expect(
      ingestDocuments(docs, { embeddingClient: other, kbRepo: repo }),
    ).rejects.toBeInstanceOf(EmbeddingModelCheckError);
  });

  it('validates every document before writing any', async () => {
    const broken = [...docs, { ...docs[0]!, docId: 'BROKEN', effectiveFrom: null }];
    await expect(
      ingestDocuments(broken, { embeddingClient: client, kbRepo: repo }),
    ).rejects.toThrow(/effective date/);
  });

  it('surfaces an embedding failure as RetrievalError(embedding_failed)', async () => {
    const failing = new FakeEmbeddingClient({
      dimension: EMBEDDING_DIMENSION,
      model: 'fake-bag-of-words',
      fail: '500',
    });
    await expect(
      ingestDocuments(docs, { embeddingClient: failing, kbRepo: repo }),
    ).rejects.toMatchObject({
      kind: 'embedding_failed',
    });
  });
});
