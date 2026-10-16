// The matrix fold (block 4), over a literal SuiteReport and EvalCase list:
// no runner, no model. Failing paths first: a fold that counts another
// assertion's reds, or treats a never-failed assertion as undefined, is
// the false green.

import { describe, expect, it } from 'vitest';
import { parseEvalCase, type EvalCase, type FaultToggle } from '../case/schema.js';
import type { CaseOutcome, RunOutcome, SuiteReport } from '../run/types.js';
import { faultMatrixResult, matrixEntryVerdict } from './matrix.js';

/** A case with the given assertion ids, each listing the toggles it expects to go red under. */
function evalCase(id: string, assertions: Record<string, FaultToggle[]>): EvalCase {
  return parseEvalCase({
    id,
    title: id,
    storeId: 'loomhaven',
    clock: '2026-09-10T12:00:00Z',
    steps: [{ kind: 'customer_message', message: 'hi' }],
    assertions: Object.entries(assertions).map(([assertionId, expectRedUnder]) => ({
      id: assertionId,
      kind: 'reply_contains',
      strings: ['x'],
      expectRedUnder,
    })),
  });
}

/** One run over the given assertion ids, failing the listed ones. */
function run(ids: string[], failing: string[] = []): RunOutcome {
  return {
    status: failing.length > 0 ? 'failed' : 'passed',
    assertions: ids.map((id) => ({
      id,
      kind: 'reply_contains',
      result: failing.includes(id) ? { passed: false, reason: `no x in ${id}` } : { passed: true },
    })),
    traceIds: [],
  };
}

const errored: RunOutcome = {
  status: 'error',
  error: { kind: 'boot_failed', message: 'no database' },
  traceIds: [],
};

/** Folds the runs with the stability rule, the way runCase does. */
function outcome(caseId: string, runs: RunOutcome[], quarantined = false): CaseOutcome {
  const statuses = runs.map((r) => r.status);
  const verdict = statuses.includes('error')
    ? 'error'
    : statuses.every((s) => s === 'passed')
      ? 'passed'
      : statuses.every((s) => s === 'failed')
        ? 'failed'
        : 'flaky';
  return { caseId, verdict, runs, quarantined };
}

function report(cases: CaseOutcome[], faultToggles: FaultToggle[] = ['stale-kb']): SuiteReport {
  return { startedAt: 0, finishedAt: 1, config: { runs: 3, faultToggles }, cases };
}

describe('matrixEntryVerdict', () => {
  it('expected red, red in one of three runs: as-expected', () => {
    expect(matrixEntryVerdict('red', 1)).toBe('as-expected');
  });
  it('expected red, red in every run: as-expected', () => {
    expect(matrixEntryVerdict('red', 3)).toBe('as-expected');
  });
  it('expected red, never red: missed-red', () => {
    expect(matrixEntryVerdict('red', 0)).toBe('missed-red');
  });
  it('expected green, never red: as-expected', () => {
    expect(matrixEntryVerdict('green', 0)).toBe('as-expected');
  });
  it('expected green, red in one of three runs: unexpected-red', () => {
    expect(matrixEntryVerdict('green', 1)).toBe('unexpected-red');
    expect(matrixEntryVerdict('green', 3)).toBe('unexpected-red');
  });
});

describe('faultMatrixResult', () => {
  const ids = ['listed', 'quiet'];
  const twoCases = [
    evalCase('a', { listed: ['stale-kb'], quiet: [] }),
    evalCase('b', { listed: ['stale-kb'], quiet: [] }),
  ];

  it('one entry per assertion of every case, in case order then assertion order', () => {
    const result = faultMatrixResult(
      ['stale-kb'],
      twoCases,
      report([outcome('a', [run(ids, ['listed'])]), outcome('b', [run(ids, ['listed'])])]),
    );
    expect(result.entries.map((entry) => `${entry.caseId}/${entry.assertionId}`)).toEqual([
      'a/listed',
      'a/quiet',
      'b/listed',
      'b/quiet',
    ]);
    expect(result.faultToggles).toEqual(['stale-kb']);
    expect(result.passed).toBe(true);
  });

  it('an assertion expects red when any toggle it lists is active, green otherwise', () => {
    const c = evalCase('c', {
      both: ['caps-per-call-only', 'stale-kb'],
      other: ['caps-per-call-only'],
      none: [],
    });
    const result = faultMatrixResult(
      ['stale-kb'],
      [c],
      report([outcome('c', [run(['both', 'other', 'none'], ['both'])])]),
    );
    expect(result.entries.map((entry) => [entry.assertionId, entry.expected])).toEqual([
      ['both', 'red'],
      ['other', 'green'],
      ['none', 'green'],
    ]);
    expect(result.passed).toBe(true);
  });

  it('with no active toggle every assertion expects green', () => {
    const green = faultMatrixResult(
      [],
      twoCases,
      report([outcome('a', [run(ids)]), outcome('b', [run(ids)])], []),
    );
    expect(green.entries.every((entry) => entry.expected === 'green')).toBe(true);
    expect(green.passed).toBe(true);
    const red = faultMatrixResult(
      [],
      twoCases,
      report([outcome('a', [run(ids, ['listed'])]), outcome('b', [run(ids)])], []),
    );
    expect(
      red.entries.find((entry) => entry.caseId === 'a' && entry.assertionId === 'listed')?.verdict,
    ).toBe('unexpected-red');
    expect(red.passed).toBe(false);
  });

  it('red runs are counted per assertion id: another assertion’s reds in the same case count for nothing', () => {
    const result = faultMatrixResult(
      ['stale-kb'],
      [twoCases[0]!],
      report([outcome('a', [run(ids, ['quiet']), run(ids, ['quiet']), run(ids)])]),
    );
    expect(result.entries).toEqual([
      expect.objectContaining({
        assertionId: 'listed',
        expected: 'red',
        redRuns: 0,
        verdict: 'missed-red',
      }),
      expect.objectContaining({
        assertionId: 'quiet',
        expected: 'green',
        redRuns: 2,
        verdict: 'unexpected-red',
      }),
    ]);
    expect(result.passed).toBe(false);
  });

  it('an assertion that never failed counts zero red runs, not undefined', () => {
    const result = faultMatrixResult(
      ['stale-kb'],
      [twoCases[0]!],
      report([outcome('a', [run(ids, ['listed']), run(ids), run(ids)])]),
    );
    const quiet = result.entries.find((entry) => entry.assertionId === 'quiet');
    expect(quiet?.redRuns).toBe(0);
    expect(quiet?.verdict).toBe('as-expected');
    expect(result.entries.find((entry) => entry.assertionId === 'listed')).toMatchObject({
      runs: 3,
      redRuns: 1,
      verdict: 'as-expected',
    });
  });

  it('errored runs count for nothing; `runs` still counts them', () => {
    const result = faultMatrixResult(
      ['stale-kb'],
      [twoCases[0]!],
      report([outcome('a', [run(ids, ['listed']), errored, run(ids)])]),
    );
    expect(result.entries.find((entry) => entry.assertionId === 'listed')).toMatchObject({
      runs: 3,
      redRuns: 1,
    });
    expect(result.entries.find((entry) => entry.assertionId === 'quiet')).toMatchObject({
      runs: 3,
      redRuns: 0,
    });
  });

  it('a case with verdict error has every entry void, and voids never fail the matrix', () => {
    const result = faultMatrixResult(
      ['stale-kb'],
      twoCases,
      report([outcome('a', [run(ids, ['listed']), errored]), outcome('b', [run(ids, ['listed'])])]),
    );
    expect(
      result.entries.filter((entry) => entry.caseId === 'a').map((entry) => entry.verdict),
    ).toEqual(['void', 'void']);
    expect(
      result.entries.filter((entry) => entry.caseId === 'b').map((entry) => entry.verdict),
    ).toEqual(['as-expected', 'as-expected']);
    expect(result.passed).toBe(true);
  });

  it('a quarantined case is folded and flagged, and its mismatches never fail the matrix', () => {
    const result = faultMatrixResult(
      ['stale-kb'],
      twoCases,
      report([outcome('a', [run(ids, ['quiet'])], true), outcome('b', [run(ids, ['listed'])])]),
    );
    const a = result.entries.filter((entry) => entry.caseId === 'a');
    expect(a.map((entry) => [entry.assertionId, entry.verdict, entry.quarantined])).toEqual([
      ['listed', 'missed-red', true],
      ['quiet', 'unexpected-red', true],
    ]);
    expect(
      result.entries.filter((entry) => entry.caseId === 'b').every((entry) => !entry.quarantined),
    ).toBe(true);
    expect(result.passed).toBe(true);
  });

  it('passed is false on any gating missed-red or unexpected-red', () => {
    const missed = faultMatrixResult(
      ['stale-kb'],
      twoCases,
      report([outcome('a', [run(ids)]), outcome('b', [run(ids, ['listed'])])]),
    );
    expect(missed.passed).toBe(false);
    const unexpected = faultMatrixResult(
      ['stale-kb'],
      twoCases,
      report([outcome('a', [run(ids, ['listed', 'quiet'])]), outcome('b', [run(ids, ['listed'])])]),
    );
    expect(unexpected.passed).toBe(false);
  });

  it('a case in the report but not in the list, or the reverse, throws naming the case id', () => {
    expect(() =>
      faultMatrixResult(['stale-kb'], twoCases, report([outcome('a', [run(ids, ['listed'])])])),
    ).toThrow(/\bb\b/);
    expect(() =>
      faultMatrixResult(
        ['stale-kb'],
        [twoCases[0]!],
        report([outcome('a', [run(ids, ['listed'])]), outcome('b', [run(ids, ['listed'])])]),
      ),
    ).toThrow(/\bb\b/);
  });
});
