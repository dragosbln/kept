-- The chunk id is unique within a store, not globally: the key becomes
-- (store_id, id). The old primary key is named by Postgres's default.
ALTER TABLE "kb_chunks" DROP CONSTRAINT "kb_chunks_pkey";--> statement-breakpoint
ALTER TABLE "kb_chunks" ADD CONSTRAINT "kb_chunks_store_id_id_pk" PRIMARY KEY("store_id","id");
