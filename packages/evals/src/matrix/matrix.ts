// HAND-WRITTEN (block 4): the matrix fold. The signatures, the types and
// the tests with empty bodies are the skeleton; the fold lands by hand.
//
// A matrix job runs the suite under one toggle and asks, per assertion,
// whether it went red where the case said it would (block 3, decision 1):
// an assertion that lists an active toggle must fail in at least one run,
// one that lists none of them must pass in every run. Error is not a
// matrix signal: a case the stability rule voided has `void` entries, which
// never count as expected and never count as a mismatch either; the exit
// code treats them as the infrastructure failure they are (reporter). A
// quarantined case is folded and reported like any other and never gates.
//
// The fold reads the suite report and the cases, nothing else: no trace,
// no ledger, no Langfuse (ADR 0001). It is pure, so the CI job can run it
// again over a saved report.

import type { EvalCase, FaultToggle } from '../case/schema.js';
import { notImplemented } from '../run/errors.js';
import type { SuiteReport } from '../run/types.js';

/** What the case promised for this assertion under the active toggles. */
export type MatrixExpectation = 'red' | 'green';

/**
 * `as-expected`: red where listed, green where not. `missed-red`: listed
 * under an active toggle and never failed, the toggle turned nothing red.
 * `unexpected-red`: listed under none of the active toggles and failed at
 * least once. `void`: the case has no verdict (an errored run).
 */
export type MatrixEntryVerdict = 'as-expected' | 'missed-red' | 'unexpected-red' | 'void';

export type MatrixEntry = {
  caseId: string;
  assertionId: string;
  expected: MatrixExpectation;
  /** How many runs the case had, errored ones included: the report's "red in n/m". */
  runs: number;
  /** In how many runs this assertion failed; errored runs count for nothing. */
  redRuns: number;
  verdict: MatrixEntryVerdict;
  /** On the quarantine list: reported, never gating. */
  quarantined: boolean;
};

export type MatrixResult = {
  faultToggles: readonly FaultToggle[];
  /** One per assertion of every case, in case order, then assertion order. */
  entries: MatrixEntry[];
  /** Every gating entry (not quarantined, not void) is as-expected. Voids are the exit code's business. */
  passed: boolean;
};

/**
 * The rule for one assertion: expected red and never red is `missed-red`,
 * expected green and ever red is `unexpected-red`, otherwise as expected.
 * Never `void`; the fold decides that from the case verdict.
 */
export function matrixEntryVerdict(
  expected: MatrixExpectation,
  redRuns: number,
): Exclude<MatrixEntryVerdict, 'void'> {
  return notImplemented(`matrixEntryVerdict(${expected}, ${redRuns})`);
}

/**
 * The fold. `cases` are the cases the suite ran, in the same selection; a
 * case in one list and not the other is a programming error and throws
 * naming the id. An assertion expects red when any toggle it lists is
 * active; with no active toggle every assertion expects green, which is
 * the suite's own exit rule restated. Per assertion, red runs are counted
 * by id with the reporter's `assertionFailureCounts`; an assertion that
 * never failed counts zero, not undefined.
 */
export function faultMatrixResult(
  faultToggles: readonly FaultToggle[],
  cases: readonly EvalCase[],
  report: SuiteReport,
): MatrixResult {
  return notImplemented(`faultMatrixResult over ${cases.length} case(s) in ${report.cases.length}`);
}
