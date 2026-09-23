CREATE EXTENSION IF NOT EXISTS vector;
--> statement-breakpoint
CREATE TABLE "kb_chunks" (
	"id" text PRIMARY KEY NOT NULL,
	"store_id" text NOT NULL,
	"doc_id" text NOT NULL,
	"doc_title" text NOT NULL,
	"section_ref" text NOT NULL,
	"tier" text NOT NULL,
	"version" text NOT NULL,
	"effective_from" bigint,
	"effective_to" bigint,
	"text" text NOT NULL,
	"embedding" vector(1536) NOT NULL,
	"embedding_model" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "kb_chunks_tier_check" CHECK ("kb_chunks"."tier" in ('binding', 'informational'))
);
--> statement-breakpoint
CREATE INDEX "kb_chunks_store_tier_idx" ON "kb_chunks" USING btree ("store_id","tier");