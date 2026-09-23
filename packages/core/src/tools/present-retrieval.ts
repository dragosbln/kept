import type { RetrievalResult, RetrievedChunk } from '../retrieval/types.js';
import type { ToolResult } from './types.js';
import { settle } from './utils.js';

/**
 * HAND-WRITTEN (block 2): the refusal rule, as the model reads it. Every
 * verdict is a successful retrieval and settles `ok` (the tool pin in the
 * sketch); the text is what changes:
 *
 *   - grounded: the chunks with tier labels and dates, binding first,
 *     each with its citation (doc id and section) so the reply can cite.
 *   - informational_only: says so, forbids quoting figures or values from
 *     it, and tells the model what to tell the customer ("a person will
 *     confirm").
 *   - no_match: what to tell the customer, and whether one more search
 *     with different wording is allowed.
 *
 * Dropped chunks are never shown to the model; they are in the raw result
 * for the trace. The raw result is the RetrievalResult unchanged.
 */
type ModelChunkView = Pick<RetrievedChunk, 'docTitle' | 'text' | 'tier'> & {
  citation: string;
  effectiveFrom: string;
  effectiveTo?: string;
};

function chunkForModel(chunk: RetrievedChunk): ModelChunkView {
  return {
    docTitle: chunk.docTitle,
    citation: `${chunk.docId} ${chunk.sectionRef}`,
    text: chunk.text,
    tier: chunk.tier,
    effectiveFrom: chunk.effectiveFrom ? new Date(chunk.effectiveFrom).toISOString() : 'undated',
    ...(chunk.effectiveTo ? { effectiveTo: new Date(chunk.effectiveTo).toISOString() } : {}),
  };
}

export function presentRetrieval(result: RetrievalResult): ToolResult {
  const survivingChunks = result.chunks.filter((ch) => !ch.dropped);
  const bindingModelChunks = survivingChunks
    .filter((ch) => ch.tier === 'binding')
    .map(chunkForModel);
  const informationalModelChunks = survivingChunks
    .filter((ch) => ch.tier === 'informational')
    .map(chunkForModel);
  switch (result.verdict) {
    case 'grounded':
      return settle.ok(
        `Retrieval is grounded; it returned the following binding sections: ${JSON.stringify(bindingModelChunks)}. ${informationalModelChunks.length ? `The retrieval also includes help-center articles: ${JSON.stringify(informationalModelChunks)}. ` : ''}Binding sections control. A help-center figure may be quoted if the binding piece references it.`,
        result,
      );
    case 'informational_only':
      return settle.ok(
        `Retrieval returned only help-center articles: ${JSON.stringify(informationalModelChunks)}. Do not quote numbers or dates, and say that a human would have to confirm those.`,
        result,
      );
    case 'no_match':
      return settle.ok(
        `Retrieval didn't return any articles. You may retry once with different wording. Otherwise escalate the question.`,
        result,
      );
    default:
      result.verdict satisfies never;
      return settle.unknown('Unexpected retrieval verdict.', result);
  }
}
