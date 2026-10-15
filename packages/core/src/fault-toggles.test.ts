// The vocabulary and the env parser. What each toggle does is pinned at its
// seam (policy, executor, retrieval); here only the names and the parsing.

import { describe, expect, it } from 'vitest';
import {
  FAULT_TOGGLES,
  faultToggleNotImplemented,
  isFaultToggle,
  parseFaultToggles,
} from './fault-toggles.js';

describe('parseFaultToggles', () => {
  it('unset, empty and blank mean no toggles', () => {
    expect(parseFaultToggles(undefined)).toEqual([]);
    expect(parseFaultToggles('')).toEqual([]);
    expect(parseFaultToggles(' , ,')).toEqual([]);
  });

  it('splits on commas, trims, keeps the given order and collapses duplicates', () => {
    expect(parseFaultToggles(' stale-kb, retrieval-scope-off ,stale-kb')).toEqual([
      'stale-kb',
      'retrieval-scope-off',
    ]);
  });

  it('refuses an unknown name, naming the variable and the list', () => {
    expect(() => parseFaultToggles('stale-kb,stale-bk')).toThrow(
      /KEPT_FAULT_TOGGLES: unknown fault toggle "stale-bk"; one of caps-per-call-only/,
    );
  });

  it('accepts every listed toggle and nothing else', () => {
    for (const toggle of FAULT_TOGGLES) expect(isFaultToggle(toggle)).toBe(true);
    expect(isFaultToggle('Stale-KB')).toBe(false);
    expect(isFaultToggle('')).toBe(false);
  });
});

describe('faultToggleNotImplemented', () => {
  it('throws, naming the toggle', () => {
    expect(() => faultToggleNotImplemented('stale-kb')).toThrow(/"stale-kb" is not implemented/);
  });
});
