// A policy document as ingestion receives it: metadata that becomes chunk
// metadata, plus sections the chunker turns into chunks. The schema is the
// contract with whoever writes documents (the fixture loader today, a
// merchant's folder later), so it says the domain rules out loud.

import { z } from 'zod';
import { KB_CHUNK_TIERS } from './types.js';

const SourceSectionSchema = z.object({
  /** The citation unit: `§n`, or the doc id for an article without sections. Unique within the document. */
  ref: z.string().min(1),
  heading: z.string().min(1),
  text: z.string().min(1),
});

export const SourceDocumentSchema = z
  .object({
    docId: z.string().min(1),
    storeId: z.string().min(1),
    title: z.string().min(1),
    tier: z.enum(KB_CHUNK_TIERS),
    version: z.string().min(1),
    /** Epoch ms, UTC midnight of the effective date. */
    effectiveFrom: z.number().int().nullable(),
    /** Epoch ms, UTC midnight of the first day the document no longer applies (exclusive). */
    effectiveTo: z.number().int().nullable(),
    sections: z.array(SourceSectionSchema).min(1),
  })
  .superRefine((doc, ctx) => {
    if (doc.tier === 'binding' && doc.effectiveFrom === null) {
      ctx.addIssue({
        code: 'custom',
        path: ['effectiveFrom'],
        message: 'a binding document needs an effective date',
      });
    }
    if (doc.tier === 'informational' && (doc.effectiveFrom !== null || doc.effectiveTo !== null)) {
      ctx.addIssue({
        code: 'custom',
        path: ['effectiveFrom'],
        message: 'an informational document carries no dates: its freshness is unknown by design',
      });
    }
    if (
      doc.effectiveFrom !== null &&
      doc.effectiveTo !== null &&
      doc.effectiveTo <= doc.effectiveFrom
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['effectiveTo'],
        message: 'effectiveTo must be after effectiveFrom',
      });
    }
    const refs = new Set<string>();
    for (const [index, section] of doc.sections.entries()) {
      if (refs.has(section.ref)) {
        ctx.addIssue({
          code: 'custom',
          path: ['sections', index, 'ref'],
          message: `duplicate section ref "${section.ref}"`,
        });
      }
      refs.add(section.ref);
    }
  });

export type SourceDocument = z.infer<typeof SourceDocumentSchema>;
export type SourceSection = SourceDocument['sections'][number];

/** Throws a ZodError on an invalid document; meant for ingestion, never per request. */
export function parseSourceDocument(input: unknown): SourceDocument {
  return SourceDocumentSchema.parse(input);
}
