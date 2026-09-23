// The fixture corpus as ingestion sees it. These pin the loader's contract
// with the Markdown format (README in the fixtures directory) and the
// corpus's own shape, so a fixture edit that breaks either fails here
// rather than at the first search.

import { describe, expect, it } from 'vitest';
import { loadPolicyDocuments, parsePolicyMarkdown } from './loader.js';

const REFS_1_TO_12 = Array.from({ length: 12 }, (_, index) => `§${index + 1}`);

describe('policy fixture corpus', () => {
  it('loads the twenty documents of the two merchants', async () => {
    const docs = await loadPolicyDocuments();
    expect(docs).toHaveLength(20);
    expect(docs.filter((doc) => doc.tier === 'binding')).toHaveLength(9);
    expect(docs.filter((doc) => doc.tier === 'informational')).toHaveLength(11);
    expect(new Set(docs.map((doc) => doc.storeId))).toEqual(new Set(['loomhaven', 'averlane']));
    expect(new Set(docs.map((doc) => doc.docId)).size).toBe(20);
  });

  it('splits a binding document into its numbered sections', async () => {
    const docs = await loadPolicyDocuments();
    const lhRet = docs.find((doc) => doc.docId === 'LH-RET');
    expect(lhRet).toBeDefined();
    expect(lhRet!.sections.map((section) => section.ref)).toEqual(REFS_1_TO_12);
    expect(lhRet!.sections[1]).toMatchObject({ ref: '§2', heading: '§2 Return window' });
    expect(lhRet!.sections[1]!.text).toContain('§2.1');
    expect(lhRet!.sections[1]!.text).toContain('§2.3');
    expect(lhRet!.title).toBe('Loomhaven Apparel Co. — Return & Refund Policy');
    expect(lhRet!.version).toBe('1.2');
    expect(lhRet!.effectiveFrom).toBe(Date.UTC(2026, 2, 1));
    expect(lhRet!.effectiveTo).toBeNull();
  });

  it('reads an article without headings as one undated section named after the document', async () => {
    const docs = await loadPolicyDocuments();
    const article = docs.find((doc) => doc.docId === 'HC-LH-05');
    expect(article).toMatchObject({
      tier: 'informational',
      version: 'undated',
      effectiveFrom: null,
      effectiveTo: null,
    });
    expect(article!.sections).toHaveLength(1);
    expect(article!.sections[0]).toMatchObject({ ref: 'HC-LH-05', heading: article!.title });
    expect(article!.sections[0]!.text).toContain('always free');
  });

  it('carries the exclusive expiry of the holiday addenda', async () => {
    const docs = await loadPolicyDocuments();
    for (const docId of ['LH-HOL-2025', 'AV-HOL-2025']) {
      const addendum = docs.find((doc) => doc.docId === docId);
      expect(addendum?.tier).toBe('binding');
      expect(addendum?.effectiveTo).toBe(Date.UTC(2026, 1, 1));
    }
  });

  it('refuses a binding document without an effective date', () => {
    const markdown = [
      '---',
      'doc_id: X-1',
      'title: Test',
      'store_id: test',
      'tier: binding',
      'version: "1"',
      'effective_from: unknown',
      'effective_to: none',
      '---',
      '## §1 Scope',
      '',
      'Some text.',
      '',
    ].join('\n');
    expect(() => parsePolicyMarkdown(markdown, 'x-1.md')).toThrow(/effective date/);
  });

  it('refuses an informational document that carries a date', () => {
    const markdown = [
      '---',
      'doc_id: HC-X',
      'title: Test',
      'store_id: test',
      'tier: informational',
      'version: "undated"',
      'effective_from: 2026-01-01',
      'effective_to: none',
      '---',
      'Some text.',
      '',
    ].join('\n');
    expect(() => parsePolicyMarkdown(markdown, 'hc-x.md')).toThrow(/freshness is unknown/);
  });

  it('refuses a malformed date', () => {
    const markdown = [
      '---',
      'doc_id: X-2',
      'title: Test',
      'store_id: test',
      'tier: binding',
      'version: "1"',
      'effective_from: March 1, 2026',
      'effective_to: none',
      '---',
      '## §1 Scope',
      '',
      'Some text.',
      '',
    ].join('\n');
    expect(() => parsePolicyMarkdown(markdown, 'x-2.md')).toThrow(/YYYY-MM-DD/);
  });
});
