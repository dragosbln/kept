// Public surface of the retrieval core: the query side (service, tool
// result shapes), the write side (ingestion over the fixture corpus), the
// Postgres store, and the embedding clients.

export type {
  DistanceKBChunk,
  EmbeddingVector,
  IngestionChunk,
  KBChunk,
  KBChunkTier,
  KBRepository,
  RetrievalResult,
  RetrievalScope,
  RetrievalVerdict,
  RetrieveKBChunksOptions,
  RetrievedChunk,
} from './types.js';
export { KB_CHUNK_TIERS, RETRIEVAL_VERDICTS } from './types.js';
export { DEFAULT_RETRIEVAL_CONFIG } from './config.js';
export type { RetrievalServiceConfig } from './config.js';
export { SourceDocumentSchema, parseSourceDocument } from './source-document.js';
export type { SourceDocument, SourceSection } from './source-document.js';
export type { EmbeddingClient } from './embedding/client.js';
export type { EmbedResponse, EmbeddingClientConfig, EmbeddingProvider } from './embedding/types.js';
export { DEFAULT_OPENAI_EMBEDDING_MODEL, OpenAIEmbeddingClient } from './embedding/openai.js';
export type { OpenAIEmbeddingTransportOptions } from './embedding/openai.js';
export { FakeEmbeddingClient, bagOfWordsVector } from './embedding/fake.js';
export type { FakeEmbeddingOptions } from './embedding/fake.js';
export { chunkDocument, embeddingInputFor } from './chunker.js';
export { RetrievalError, RetrievalService } from './service.js';
export type { RetrievalErrorKind } from './service.js';
export {
  EmbeddingModelCheckError,
  assertStoreEmbeddingModel,
  checkEmbeddingModelsAgree,
} from './boot.js';
export type { EmbeddingModelCheckCode, EmbeddingModelCheckOptions } from './boot.js';
export { DEFAULT_INGEST_BATCH_SIZE, ingestDocuments, kbChunkId } from './ingest.js';
export type { IngestDeps, IngestOptions, IngestReport } from './ingest.js';
export { createDb } from './pg/db.js';
export type { CreateDbOptions, DbHandle, KeptDb } from './pg/db.js';
export { EMBEDDING_DIMENSION, kbChunks } from './pg/schema.js';
export type { KbChunkInsert, KbChunkRow } from './pg/schema.js';
export { PgKBRepository, fromRow, toRow } from './pg/kb-repository.js';
export { MIGRATIONS_DIR, migrateDb } from './pg/migrate.js';
export {
  POLICY_FIXTURES_DIR,
  loadPolicyDocuments,
  parsePolicyMarkdown,
} from './fixtures/loader.js';
export { ScriptedKBRepository, distanceChunk, stubRetrievalService } from './testing.js';
export type { ScriptedRows } from './testing.js';
