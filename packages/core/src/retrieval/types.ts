// The retrieval core's vocabulary. The block-2 sketch (journal, 2026-09-21)
// is the source; comments name the decision a field serves so a reader can
// check the code against the design.

export type KBChunkTier = 'binding' | 'informational';

export const KB_CHUNK_TIERS = [
  'binding',
  'informational',
] as const satisfies readonly KBChunkTier[];

/** One embedding. Its dimension is fixed per store by the model that produced it. */
export type EmbeddingVector = number[];

/**
 * One row of the knowledge base: a section of a policy document, embedded
 * once (decision 1). Tier is ingestion metadata, never inferred from prose
 * (decision 6). The row carries the model that embedded it so the boot and
 * ingest checks can refuse a client that disagrees (decision 2).
 */
export type KBChunk = {
  /** Deterministic, `docId@version#sectionRef`: re-ingesting a fixture upserts instead of duplicating. */
  id: string;
  /** Where the policy applies: one merchant storefront. A scope filter, never model-chosen (decision 4). */
  storeId: string;
  docId: string;
  docTitle: string;
  /** The citation unit: `§n` for a numbered section, the doc id for an article without sections. */
  sectionRef: string;
  tier: KBChunkTier;
  version: string;
  /** Epoch ms, UTC. Null on informational documents: their freshness is unknown by design (decision 6). */
  effectiveFrom: number | null;
  /** Epoch ms, UTC, exclusive: the first instant the document no longer applies. Null when open-ended. */
  effectiveTo: number | null;
  /** What the model reads when the chunk is cited. */
  text: string;
  embedding: EmbeddingVector;
  embeddingModel: string;
};

/** What the chunker produces: content and metadata. Identity and embedding are ingestion's. */
export type IngestionChunk = Omit<KBChunk, 'id' | 'embedding' | 'embeddingModel'>;

/** A stored chunk beside its distance to a query. The embedding itself stays in the database. */
export type DistanceKBChunk = Omit<KBChunk, 'embedding'> & {
  /** Cosine distance: 0 identical, 1 orthogonal, 2 opposite. Smaller is closer. */
  distance: number;
};

export type RetrieveKBChunksOptions = {
  storeId: string;
  tiers: KBChunkTier[];
  /**
   * Epoch ms. Present: the effective-date window is applied. Absent: it is
   * not, which is how informational chunks are queried (decision 6).
   */
  asOf?: number;
  queryVector: EmbeddingVector;
  topK: number;
};

export interface KBRepository {
  /**
   * Filter, then rank by cosine distance, then limit (decision 3). The
   * threshold is the service's, applied in code, so dropped rows stay
   * visible; the query never applies it.
   */
  retrieve(options: RetrieveKBChunksOptions): Promise<DistanceKBChunk[]>;
  /** Insert or replace by id; idempotent, so ingesting a fixture twice leaves one row per chunk. */
  upsertBatch(chunks: KBChunk[]): Promise<void>;
  /** `SELECT DISTINCT embedding_model … WHERE store_id = $1`: what the boot and ingest checks read (decision 2). */
  getEmbeddingModelsForStore(storeId: string): Promise<string[]>;
  /** Removes every chunk of a store and returns how many. Tests and a wipe-and-reload use it. */
  deleteStore(storeId: string): Promise<number>;
}

/** A chunk as the tool, the span and an eval read it (decision 7): dates included, embedding left out. */
export type RetrievedChunk = Pick<
  KBChunk,
  | 'id'
  | 'docId'
  | 'docTitle'
  | 'sectionRef'
  | 'tier'
  | 'version'
  | 'text'
  | 'effectiveFrom'
  | 'effectiveTo'
> & {
  distance: number;
  /** Past the threshold. Kept in the result so the span shows what was ranked and cut (decision 3). */
  dropped: boolean;
};

/**
 * Computed by the service after the threshold, from the chunks that cleared
 * it (decision 6): `grounded` when at least one binding chunk did,
 * `informational_only` when only help-tier chunks did, `no_match` when
 * nothing did. Derived, so it carries nothing the chunks do not; it exists
 * so the tool renders one switch, the span records one word, and an eval
 * asserts one field instead of re-deriving the rule from distances.
 */
export type RetrievalVerdict = 'grounded' | 'informational_only' | 'no_match';

export const RETRIEVAL_VERDICTS = [
  'grounded',
  'informational_only',
  'no_match',
] as const satisfies readonly RetrievalVerdict[];

/** One shape for the tool's raw result, the retrieval span's end payload and the eval assertions. */
export type RetrievalResult = {
  verdict: RetrievalVerdict;
  /** Binding first, then informational; by distance within a tier. Dropped chunks included, flagged. */
  chunks: RetrievedChunk[];
};

/** Travels with the tool call from the host, never from the model (decision 4). */
export type RetrievalScope = {
  storeId: string;
  /** The conversation's clock, epoch ms. The eval runner and the simulator set it; core never reads Date.now(). */
  asOf: number;
};
