import type { SourceDocument } from './source-document.js';
import type { IngestionChunk } from './types.js';

/**
 * HAND-WRITTEN (block 2, learning contract): the chunking rule.
 *
 * Decision 8: one chunk per numbered section, heading included, sub-clauses
 * kept together (60–150 words on this corpus); an article without sections
 * is one chunk. `sectionRef` is the citation unit. Everything except the
 * two strings below is the document's metadata copied onto each chunk.
 *
 * Two strings to decide, one per function:
 *   - `text`: what the model reads when the chunk is cited.
 *   - the embedding input: what the vector is computed from. A bare
 *     sub-clause ("The §6.1 fee is waived for §5 returns") embeds as
 *     nothing; the title and heading in front of it give it a topic.
 */
export function chunkDocument(document: SourceDocument): IngestionChunk[] {
  return document.sections.map((section) => ({
    docId: document.docId,
    sectionRef: section.ref,
    effectiveFrom: document.effectiveFrom,
    effectiveTo: document.effectiveTo,
    version: document.version,
    tier: document.tier,
    text: `${section.heading}\n${section.text}`,
    storeId: document.storeId,
    docTitle: document.title,
  }));
}

/** HAND-WRITTEN: the string that gets embedded for a chunk; may differ from its stored text. */
export function embeddingInputFor(chunk: IngestionChunk): string {
  return `Document title: ${chunk.docTitle}\n${chunk.text}`;
}
