// The refusal rule as the model reads it (hand-written, block 2). These pin
// the tool pin from the sketch: every verdict settles ok, the raw result
// travels unchanged, dropped chunks never reach the model, binding comes
// first with a citation and dates, and each verdict says what to do.

import { describe, expect, it } from 'vitest';
import { presentRetrieval } from './present-retrieval.js';
import type { RetrievalResult, RetrievedChunk } from '../retrieval/types.js';

const binding: RetrievedChunk = {
  id: 'LH-RET@1.2#§6',
  docId: 'LH-RET',
  docTitle: 'Loomhaven Apparel Co. — Return & Refund Policy',
  sectionRef: '§6',
  tier: 'binding',
  version: '1.2',
  effectiveFrom: Date.UTC(2026, 2, 1),
  effectiveTo: null,
  text: '§6 Return shipping, fees, and promotional adjustments\n§6.1 A flat fee of $6.50 per return request is deducted.',
  distance: 0.18,
  dropped: false,
};

/** In force with a known end: the one case where the end date is what the customer needs to hear. */
const addendum: RetrievedChunk = {
  ...binding,
  id: 'LH-HOL-2025@1.0#§1',
  docId: 'LH-HOL-2025',
  docTitle: 'Loomhaven Apparel Co. — Holiday Returns Addendum 2025',
  sectionRef: '§1',
  version: '1.0',
  effectiveFrom: Date.UTC(2025, 10, 1),
  effectiveTo: Date.UTC(2026, 1, 1),
  text: '§1 Extended window\nEligible items ordered between November 1 and December 24 may be returned until January 31.',
  distance: 0.3,
};

const article: RetrievedChunk = {
  ...binding,
  id: 'HC-LH-05@undated#HC-LH-05',
  docId: 'HC-LH-05',
  docTitle: 'Loomhaven Apparel Co. Help Center — Is return shipping free?',
  sectionRef: 'HC-LH-05',
  tier: 'informational',
  version: 'undated',
  effectiveFrom: null,
  effectiveTo: null,
  text: 'Yes — returns at Loomhaven are always free.',
  distance: 0.12,
};

const dropped: RetrievedChunk = {
  ...binding,
  id: 'LH-PAY@1.0#§7',
  docId: 'LH-PAY',
  sectionRef: '§7',
  text: '§7 Payment disputes\nRefund processing is suspended while a dispute is open.',
  distance: 0.9,
  dropped: true,
};

const grounded: RetrievalResult = {
  verdict: 'grounded',
  chunks: [binding, addendum, dropped, article],
};

describe('presentRetrieval', () => {
  it('every verdict settles ok and carries the raw result unchanged', () => {
    for (const result of [
      grounded,
      { verdict: 'informational_only', chunks: [dropped, article] } satisfies RetrievalResult,
      { verdict: 'no_match', chunks: [dropped] } satisfies RetrievalResult,
    ]) {
      const settled = presentRetrieval(result);
      expect(settled.resultState).toBe('ok');
      expect(settled.result).toBe(result);
    }
  });

  it('grounded: binding sections first with citation and dates, articles after, precedence stated', () => {
    const { response } = presentRetrieval(grounded);
    expect(response).toContain('"citation":"LH-RET §6"');
    expect(response).toContain('"citation":"HC-LH-05 HC-LH-05"');
    expect(response.indexOf('LH-RET §6')).toBeLessThan(response.indexOf('HC-LH-05'));
    expect(response).toContain('"tier":"binding"');
    expect(response).toContain('"tier":"informational"');
    expect(response).toMatch(/binding sections control/i);
    // The text travels JSON-escaped, so match a fragment rather than the raw multi-line string.
    expect(response).toContain('§6.1 A flat fee of $6.50 per return request is deducted.');
  });

  it("grounded: dates are the chunk's own, start and end, calendar-readable", () => {
    const { response } = presentRetrieval(grounded);
    // The open-ended policy starts on March 1 and has no end: its end must not read as March 1.
    expect(response).toContain('"effectiveFrom":"2026-03-01');
    expect(response).not.toContain('"effectiveTo":"2026-03-01');
    // The addendum starts November 1 and ends February 1 (exclusive): both must be there.
    expect(response).toContain('"effectiveFrom":"2025-11-01');
    expect(response).toContain('"effectiveTo":"2026-02-01');
    // Undated article: no fabricated freshness.
    expect(response).toContain('"effectiveFrom":"undated"');
  });

  it('never shows a dropped chunk to the model', () => {
    const { response } = presentRetrieval(grounded);
    expect(response).not.toContain('LH-PAY');
    expect(response).not.toContain('Payment disputes');
  });

  it('grounded without articles does not mention articles', () => {
    const { response } = presentRetrieval({ verdict: 'grounded', chunks: [binding] });
    expect(response).not.toMatch(/help-center articles: \[\]/);
  });

  it('informational_only: shows the articles, forbids figures, routes confirmation to a person', () => {
    const { response } = presentRetrieval({
      verdict: 'informational_only',
      chunks: [dropped, article],
    });
    expect(response).toContain('"citation":"HC-LH-05 HC-LH-05"');
    expect(response).not.toContain('LH-PAY');
    expect(response).toMatch(/do not quote numbers/i);
    expect(response).toMatch(/human|person/i);
  });

  it('no_match: allows one reworded retry, then escalates', () => {
    const { response } = presentRetrieval({ verdict: 'no_match', chunks: [dropped] });
    expect(response).toMatch(/retry once/i);
    expect(response).toMatch(/escalate/i);
    expect(response).not.toContain('LH-PAY');
  });
});
