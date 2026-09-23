// Loads the fixture policy corpus (packages/core/fixtures/policy-docs, both
// merchants) into the knowledge base: validate, chunk, embed with OpenAI,
// upsert. Idempotent on the deterministic chunk id, so re-running after a
// fixture edit replaces the changed rows and leaves the rest.
//
//   pnpm kb:ingest

import {
  DEFAULT_OPENAI_EMBEDDING_MODEL,
  EMBEDDING_DIMENSION,
  OpenAIEmbeddingClient,
  PgKBRepository,
  createDb,
  ingestDocuments,
  loadPolicyDocuments,
  migrateDb,
} from '../packages/core/src/index.ts';

const url = process.env['DATABASE_URL'];
const apiKey = process.env['OPENAI_API_KEY'];
if (!url) {
  throw new Error('DATABASE_URL is not set; copy .env.example to .env and run `pnpm stack:up`');
}
if (!apiKey) {
  throw new Error(
    'OPENAI_API_KEY is not set; embeddings need it whichever provider answers the customer',
  );
}
const model = process.env['KEPT_EMBEDDING_MODEL']?.trim() || DEFAULT_OPENAI_EMBEDDING_MODEL;

await migrateDb(url);

const handle = createDb(url, { max: 2 });
try {
  const documents = await loadPolicyDocuments();
  console.log(`corpus: ${documents.length} documents`);
  const report = await ingestDocuments(documents, {
    embeddingClient: new OpenAIEmbeddingClient({ model, dimension: EMBEDDING_DIMENSION }, apiKey),
    kbRepo: new PgKBRepository(handle.db),
  });
  for (const [storeId, count] of Object.entries(report.chunksByStore)) {
    console.log(`  ${storeId}: ${count} chunks`);
  }
  console.log(`ingested ${report.chunks} chunks from ${report.documents} documents with ${model}`);
} finally {
  await handle.close();
}
