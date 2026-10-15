import { describe, expect, it } from 'vitest';
import type { MatrixEntry, MatrixResult } from '../matrix/matrix.js';
import type { CaseOutcome, RunOutcome, SuiteReport } from '../run/types.js';
import {
  assertionFailureCounts,
  exitCodeFor,
  exitCodeForMatrix,
  formatMatrixReport,
  formatSuiteReport,
} from './reporter.js';

const passed = (id: string): RunOutcome => ({
  status: 'passed',
  assertions: [{ id, kind: 'reply_contains', result: { passed: true } }],
  traceIds: ['t-pass'],
});
const failed = (id: string, reason: string): RunOutcome => ({
  status: 'failed',
  assertions: [
    { id, kind: 'reply_contains', result: { passed: false, reason, traceId: 'abcdef123456789' } },
  ],
  traceIds: ['abcdef123456789'],
});
const errored: RunOutcome = {
  status: 'error',
  error: { kind: 'boot_failed', message: 'no database' },
  traceIds: [],
};

function report(cases: CaseOutcome[]): SuiteReport {
  return { startedAt: 0, finishedAt: 12_000, config: { runs: 3, faultToggles: [] }, cases };
}

describe('exitCodeFor', () => {
  it('is 0 only when every non-quarantined case passed', () => {
    const green: CaseOutcome = { caseId: 'a', verdict: 'passed', runs: [], quarantined: false };
    const red: CaseOutcome = { caseId: 'b', verdict: 'flaky', runs: [], quarantined: false };
    expect(exitCodeFor(report([green]))).toBe(0);
    expect(exitCodeFor(report([green, red]))).toBe(1);
    expect(exitCodeFor(report([green, { ...red, quarantined: true }]))).toBe(0);
    expect(exitCodeFor(report([{ ...green, verdict: 'error' }]))).toBe(1);
  });
});

describe('assertionFailureCounts', () => {
  it('counts, per assertion id, the runs it failed in; errored runs count for nothing', () => {
    const outcome: CaseOutcome = {
      caseId: 'c',
      verdict: 'flaky',
      runs: [failed('cited', 'no §6'), passed('cited'), errored],
      quarantined: false,
    };
    expect([...assertionFailureCounts(outcome)]).toEqual([['cited', 1]]);
  });
});

describe('formatSuiteReport', () => {
  it('one line per case, failing assertions under it with the first reason and a trace id', () => {
    const text = formatSuiteReport(
      report([
        { caseId: 'ok-case', verdict: 'passed', runs: [passed('x')], quarantined: false },
        {
          caseId: 'red-case',
          verdict: 'flaky',
          runs: [failed('cited', 'reply had no §6'), passed('cited'), passed('cited')],
          quarantined: false,
        },
        { caseId: 'boom', verdict: 'error', runs: [errored], quarantined: true },
      ]),
      [{ id: 'ok-case', title: 'The green one' } as never],
    );
    expect(text).toContain('evals: 3 case(s) × 3 run(s), toggles: none, 12s');
    expect(text).toContain('PASS  ok-case  The green one');
    expect(text).toContain('FLAKY red-case');
    expect(text).toContain('cited  1/3  reply had no §6 [trace abcdef123456]');
    expect(text).toContain('ERROR boom  boom  (quarantined, not gating)');
    expect(text).toContain('boot_failed: no database');
    expect(text).toContain('1 passed, 0 failed, 1 flaky, 1 error, 1 quarantined');
    expect(text.endsWith('exit 1')).toBe(true);
  });
});

// The matrix section, over a literal MatrixResult: the fold itself is
// matrix/matrix.test.ts's (hand-written, block 4).

function entry(
  overrides: Partial<MatrixEntry> & Pick<MatrixEntry, 'assertionId' | 'verdict'>,
): MatrixEntry {
  return {
    caseId: 'case-a',
    expected: overrides.verdict === 'missed-red' ? 'red' : 'green',
    runs: 3,
    redRuns: 0,
    quarantined: false,
    ...overrides,
  };
}

function matrix(entries: MatrixEntry[]): MatrixResult {
  return {
    faultToggles: ['stale-kb'],
    entries,
    passed: !entries.some(
      (e) => !e.quarantined && e.verdict !== 'void' && e.verdict !== 'as-expected',
    ),
  };
}

describe('exitCodeForMatrix', () => {
  it('is 0 only when every gating entry is as expected; a void outside quarantine fails the job', () => {
    const hit = entry({ assertionId: 'hit', verdict: 'as-expected', expected: 'red', redRuns: 2 });
    expect(exitCodeForMatrix(matrix([hit]))).toBe(0);
    expect(
      exitCodeForMatrix(matrix([hit, entry({ assertionId: 'm', verdict: 'missed-red' })])),
    ).toBe(1);
    expect(
      exitCodeForMatrix(
        matrix([hit, entry({ assertionId: 'u', verdict: 'unexpected-red', redRuns: 1 })]),
      ),
    ).toBe(1);
    expect(exitCodeForMatrix(matrix([hit, entry({ assertionId: 'v', verdict: 'void' })]))).toBe(1);
    expect(
      exitCodeForMatrix(
        matrix([
          hit,
          entry({ assertionId: 'v', verdict: 'void', quarantined: true }),
          entry({ assertionId: 'm', verdict: 'missed-red', quarantined: true }),
        ]),
      ),
    ).toBe(0);
  });
});

describe('formatMatrixReport', () => {
  it('lists the expected reds that hit, every mismatch and void, marks quarantine, and tallies', () => {
    const text = formatMatrixReport(
      matrix([
        entry({ assertionId: 'hit', verdict: 'as-expected', expected: 'red', redRuns: 3 }),
        entry({ assertionId: 'quiet', verdict: 'as-expected' }),
        entry({ assertionId: 'missed', verdict: 'missed-red' }),
        entry({ caseId: 'case-b', assertionId: 'leak', verdict: 'unexpected-red', redRuns: 1 }),
        entry({ caseId: 'case-c', assertionId: 'gone', verdict: 'void', quarantined: true }),
      ]),
    );
    expect(text).toContain('matrix: toggles stale-kb, 5 assertion(s)');
    expect(text).toContain('ok         case-a / hit  red in 3/3, listed under stale-kb');
    expect(text).not.toContain('quiet');
    expect(text).toContain('MISSED     case-a / missed  red in 0/3, listed under stale-kb');
    expect(text).toContain('UNEXPECTED case-b / leak  red in 1/3, not listed under stale-kb');
    expect(text).toContain(
      'VOID       case-c / gone  no verdict: a run errored, not listed under stale-kb  (quarantined, not gating)',
    );
    expect(text).toContain(
      '2 as expected (1 expected red hit), 1 missed red, 1 unexpected red, 1 void, 1 quarantined',
    );
    expect(text).toContain('exit 1');
  });
});
