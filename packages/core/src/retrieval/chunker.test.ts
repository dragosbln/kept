// Pins decision 8 over the real fixtures. Red until chunkDocument is
// written (hand, block 2); green is the exit condition for the chunker.

import { describe, expect, it } from 'vitest';
import { chunkDocument, embeddingInputFor } from './chunker.js';
import { loadPolicyDocuments } from './fixtures/loader.js';
import type { SourceDocument } from './source-document.js';

async function fixture(docId: string): Promise<SourceDocument> {
  const doc = (await loadPolicyDocuments()).find((candidate) => candidate.docId === docId);
  if (!doc) throw new Error(`fixture ${docId} missing`);
  return doc;
}

describe('chunkDocument (decision 8: one chunk per numbered section)', () => {
  it('turns LH-RET into twelve chunks, one per section, heading and sub-clauses together', async () => {
    const chunks = chunkDocument(await fixture('LH-RET'));
    expect(chunks).toHaveLength(12);
    expect(chunks.map((chunk) => chunk.sectionRef)).toEqual(
      Array.from({ length: 12 }, (_, index) => `§${index + 1}`),
    );
    const returnWindow = chunks[1]!;
    expect(returnWindow.text).toContain('§2 Return window');
    expect(returnWindow.text).toContain('§2.1');
    expect(returnWindow.text).toContain('§2.3');
  });

  it('copies the document metadata onto every chunk', async () => {
    const doc = await fixture('LH-HOL-2025');
    for (const chunk of chunkDocument(doc)) {
      expect(chunk).toMatchObject({
        storeId: 'loomhaven',
        docId: 'LH-HOL-2025',
        docTitle: doc.title,
        tier: 'binding',
        version: '1.0',
        effectiveFrom: doc.effectiveFrom,
        effectiveTo: doc.effectiveTo,
      });
    }
  });

  it('keeps an article without sections as one undated chunk named after the document', async () => {
    const chunks = chunkDocument(await fixture('HC-LH-05'));
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatchObject({
      sectionRef: 'HC-LH-05',
      tier: 'informational',
      effectiveFrom: null,
      effectiveTo: null,
    });
    expect(chunks[0]!.text).toContain('always free');
  });

  it('produces 71 chunks over the whole corpus: 60 binding sections and 11 articles', async () => {
    const docs = await loadPolicyDocuments();
    const chunks = docs.flatMap((doc) => chunkDocument(doc));
    expect(chunks).toHaveLength(71);
    expect(chunks.filter((chunk) => chunk.tier === 'binding')).toHaveLength(60);
  });
});

describe('the two strings of the chunker', () => {
  it('stores the heading on its own first line, then the section text, with real newlines', async () => {
    const chunk = chunkDocument(await fixture('LH-RET'))[1]!;
    const [firstLine, ...rest] = chunk.text.split('\n');
    expect(firstLine).toBe('§2 Return window');
    expect(rest.join('\n')).toContain('§2.1 Items may be returned');
    expect(chunk.text).not.toContain('\\n');
  });

  it('embeds the document title and the heading in front of the text, so a bare sub-clause carries its topic', async () => {
    const chunk = chunkDocument(await fixture('LH-RET'))[1]!;
    const input = embeddingInputFor(chunk);
    expect(input).toContain('Loomhaven Apparel Co. — Return & Refund Policy');
    expect(input).toContain('§2 Return window');
    expect(input).toContain(chunk.text);
    expect(input).not.toContain('\\n');
  });
});
