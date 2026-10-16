import { and, cosineDistance, eq, gt, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import type {
  DistanceKBChunk,
  KBChunk,
  KBRepository,
  RetrieveFilterOptions,
  RetrieveKBChunksOptions,
} from '../types.js';
import type { KeptDb } from './db.js';
import { kbChunks, type KbChunkInsert, type KbChunkRow } from './schema.js';

/** Rows per INSERT; postgres.js caps a statement at 65534 parameters. */
const UPSERT_SLICE = 500;

export function toRow(chunk: KBChunk): KbChunkInsert {
  return {
    id: chunk.id,
    storeId: chunk.storeId,
    docId: chunk.docId,
    docTitle: chunk.docTitle,
    sectionRef: chunk.sectionRef,
    tier: chunk.tier,
    version: chunk.version,
    effectiveFrom: chunk.effectiveFrom,
    effectiveTo: chunk.effectiveTo,
    text: chunk.text,
    embedding: chunk.embedding,
    embeddingModel: chunk.embeddingModel,
  };
}

/** Everything but the embedding: the shape retrieve() returns beside a distance. */
export function fromRow(
  row: Omit<KbChunkRow, 'embedding' | 'createdAt'>,
): Omit<KBChunk, 'embedding'> {
  return {
    id: row.id,
    storeId: row.storeId,
    docId: row.docId,
    docTitle: row.docTitle,
    sectionRef: row.sectionRef,
    tier: row.tier,
    version: row.version,
    effectiveFrom: row.effectiveFrom,
    effectiveTo: row.effectiveTo,
    text: row.text,
    embeddingModel: row.embeddingModel,
  };
}

export class PgKBRepository implements KBRepository {
  private readonly db: KeptDb;

  constructor(db: KeptDb) {
    this.db = db;
  }

  /**
   * HAND-WRITTEN (block 2): the query of decision 3.
   *
   *   WHERE store_id = $storeId
   *     AND tier IN ($tiers)
   *     [AND effective_from <= $asOf AND (effective_to IS NULL OR $asOf < effective_to)]
   *   ORDER BY embedding <=> $queryVector
   *   LIMIT $topK
   *
   * Drizzle: `cosineDistance(kbChunks.embedding, options.queryVector)` from
   * 'drizzle-orm' is the `<=>` operator; select it as `distance` beside the
   * columns, leave the embedding out of the select, map the rest with
   * `fromRow`. Keep each predicate its own expression: block 4 drops them
   * by name.
   *
   * Block 4: `filters.storeFilterOff` leaves `inStore` out
   * (`retrieval-scope-off`). The tier predicate stays, a design delta: no
   * case needs it dropped, and dropping it would let the undated
   * informational query return expired binding sections, which is
   * `stale-kb`'s failure, not this one's. The dates need nothing new:
   * `inForce` is already absent when `asOf` is.
   */
  async retrieve(
    options: RetrieveKBChunksOptions,
    filters?: RetrieveFilterOptions,
  ): Promise<DistanceKBChunk[]> {
    const inStore = !filters?.storeFilterOff ? eq(kbChunks.storeId, options.storeId) : undefined;
    const inTiers = inArray(kbChunks.tier, options.tiers);
    const inForce =
      options.asOf !== undefined
        ? and(
            lte(kbChunks.effectiveFrom, options.asOf),
            or(isNull(kbChunks.effectiveTo), gt(kbChunks.effectiveTo, options.asOf)),
          )
        : undefined;

    const rows = await this.db
      .select({
        id: kbChunks.id,
        storeId: kbChunks.storeId,
        docId: kbChunks.docId,
        docTitle: kbChunks.docTitle,
        sectionRef: kbChunks.sectionRef,
        tier: kbChunks.tier,
        version: kbChunks.version,
        effectiveFrom: kbChunks.effectiveFrom,
        effectiveTo: kbChunks.effectiveTo,
        text: kbChunks.text,
        embeddingModel: kbChunks.embeddingModel,
        distance: cosineDistance(kbChunks.embedding, options.queryVector).mapWith(Number),
      })
      .from(kbChunks)
      .where(and(inStore, inTiers, inForce))
      .orderBy(cosineDistance(kbChunks.embedding, options.queryVector))
      .limit(options.topK);

    return rows.map((row) => {
      return Object.assign({}, fromRow(row), { distance: row.distance });
    });
  }

  async upsertBatch(chunks: KBChunk[]): Promise<void> {
    for (let start = 0; start < chunks.length; start += UPSERT_SLICE) {
      const slice = chunks.slice(start, start + UPSERT_SLICE).map(toRow);
      // oxlint-disable-next-line no-await-in-loop -- slices are sequential on purpose
      await this.db
        .insert(kbChunks)
        .values(slice)
        .onConflictDoUpdate({
          target: [kbChunks.storeId, kbChunks.id],
          set: {
            docId: sql`excluded.doc_id`,
            docTitle: sql`excluded.doc_title`,
            sectionRef: sql`excluded.section_ref`,
            tier: sql`excluded.tier`,
            version: sql`excluded.version`,
            effectiveFrom: sql`excluded.effective_from`,
            effectiveTo: sql`excluded.effective_to`,
            text: sql`excluded.text`,
            embedding: sql`excluded.embedding`,
            embeddingModel: sql`excluded.embedding_model`,
          },
        });
    }
  }

  async getEmbeddingModelsForStore(storeId: string): Promise<string[]> {
    const rows = await this.db
      .selectDistinct({ model: kbChunks.embeddingModel })
      .from(kbChunks)
      .where(eq(kbChunks.storeId, storeId));
    return rows.map((row) => row.model);
  }

  async deleteStore(storeId: string): Promise<number> {
    const deleted = await this.db
      .delete(kbChunks)
      .where(eq(kbChunks.storeId, storeId))
      .returning({ id: kbChunks.id });
    return deleted.length;
  }
}
