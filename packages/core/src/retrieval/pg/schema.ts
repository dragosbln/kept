// The knowledge base table. One table, boring: pgvector column, the
// metadata every filter reads, and the model that embedded the row.
// Epoch milliseconds for the dates, like every other timestamp in core, so
// the effective-date predicate is an integer comparison.

import { sql } from 'drizzle-orm';
import { bigint, check, index, pgTable, text, timestamp, vector } from 'drizzle-orm/pg-core';
import { KB_CHUNK_TIERS } from '../types.js';

/** The vector column's width. text-embedding-3-small's native size; the client is asked for it explicitly. */
export const EMBEDDING_DIMENSION = 1536;

export const kbChunks = pgTable(
  'kb_chunks',
  {
    id: text('id').primaryKey(),
    storeId: text('store_id').notNull(),
    docId: text('doc_id').notNull(),
    docTitle: text('doc_title').notNull(),
    sectionRef: text('section_ref').notNull(),
    tier: text('tier', { enum: KB_CHUNK_TIERS }).notNull(),
    version: text('version').notNull(),
    effectiveFrom: bigint('effective_from', { mode: 'number' }),
    effectiveTo: bigint('effective_to', { mode: 'number' }),
    text: text('text').notNull(),
    embedding: vector('embedding', { dimensions: EMBEDDING_DIMENSION }).notNull(),
    embeddingModel: text('embedding_model').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Every query filters by store and tier first (decision 3). No vector
    // index: at a few hundred rows an exact scan is both faster and simpler.
    index('kb_chunks_store_tier_idx').on(table.storeId, table.tier),
    check('kb_chunks_tier_check', sql`${table.tier} in ('binding', 'informational')`),
  ],
);

export type KbChunkRow = typeof kbChunks.$inferSelect;
export type KbChunkInsert = typeof kbChunks.$inferInsert;
