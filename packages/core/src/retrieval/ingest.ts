// Ingestion: validate, chunk, embed in batches, upsert. Plumbing around the
// two hand-written functions in chunker.ts. No re-ingest logic in v0: the
// corpus is a fixture whose effective dates come with it, and the upsert on
// a deterministic id makes running this twice a no-op.

/* oxlint-disable no-await-in-loop -- embedding batches run sequentially by design, one request in flight */

import { assertStoreEmbeddingModel } from './boot.js';
import { chunkDocument, embeddingInputFor } from './chunker.js';
import type { EmbeddingClient } from './embedding/client.js';
import { RetrievalError } from './service.js';
import { parseSourceDocument } from './source-document.js';
import type { IngestionChunk, KBChunk, KBRepository } from './types.js';

export type IngestDeps = {
  embeddingClient: EmbeddingClient;
  kbRepo: KBRepository;
};

export type IngestOptions = {
  /** Chunks per embedding request. */
  batchSize?: number;
};

export type IngestReport = {
  documents: number;
  chunks: number;
  chunksByStore: Record<string, number>;
};

export const DEFAULT_INGEST_BATCH_SIZE = 64;

/** The deterministic row id: the same document, version and section always land on the same row. */
export function kbChunkId({
  docId,
  version,
  sectionRef,
}: Pick<IngestionChunk, 'docId' | 'version' | 'sectionRef'>): string {
  return `${docId}@${version}#${sectionRef}`;
}

export async function ingestDocuments(
  documents: readonly unknown[],
  { embeddingClient, kbRepo }: IngestDeps,
  { batchSize = DEFAULT_INGEST_BATCH_SIZE }: IngestOptions = {},
): Promise<IngestReport> {
  // Validate everything before writing anything: one bad file stops the
  // load, it does not leave half of it in.
  const parsed = documents.map(parseSourceDocument);
  const { model } = embeddingClient.getConfig();

  const storeIds = [...new Set(parsed.map((doc) => doc.storeId))];
  await Promise.all(
    storeIds.map((storeId) =>
      assertStoreEmbeddingModel(kbRepo, embeddingClient, storeId, { allowEmpty: true }),
    ),
  );

  const chunks = parsed.flatMap((doc) => chunkDocument(doc));
  const rows: KBChunk[] = [];
  for (let start = 0; start < chunks.length; start += batchSize) {
    const batch = chunks.slice(start, start + batchSize);
    const response = await embeddingClient.embed(batch.map(embeddingInputFor));
    if (response.type !== 'ok') {
      throw new RetrievalError(
        'embedding_failed',
        `embedding failed (${response.errorType}) on chunks ${start}–${start + batch.length - 1}`,
        { cause: response.error },
      );
    }
    batch.forEach((chunk, index) => {
      const embedding = response.vectors[index];
      if (!embedding) {
        throw new RetrievalError(
          'embedding_failed',
          `no vector returned for chunk ${start + index}`,
        );
      }
      rows.push({ ...chunk, id: kbChunkId(chunk), embedding, embeddingModel: model });
    });
  }

  await kbRepo.upsertBatch(rows);

  const chunksByStore: Record<string, number> = {};
  for (const row of rows) {
    chunksByStore[row.storeId] = (chunksByStore[row.storeId] ?? 0) + 1;
  }
  return { documents: parsed.length, chunks: rows.length, chunksByStore };
}
