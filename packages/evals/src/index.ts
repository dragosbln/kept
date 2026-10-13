// @kept-hq/evals — the YAML case format, the runner and the assertions.
//
// Hand-written (block 3): the run loop, the observation, the stability rule
// and every assertion type (run/runner.ts, assertions/registry.ts). The
// rest is plumbing: the format and its loader, the fixture builder, the
// reporter, the command in scripts/evals.ts. The case format is a product surface, not an implementation
// detail; it is documented in README.md.

export {
  AtSchema,
  CaseAssertionSchema,
  CountSchema,
  EvalCaseSchema,
  FAULT_TOGGLES,
  FixtureOrderSchema,
  FixturesSchema,
  PriorRefundSchema,
  QuarantineEntrySchema,
  QuarantineSchema,
  RefundSelectorSchema,
  StepSchema,
  parseEvalCase,
  parseQuarantine,
} from './case/schema.js';
export type {
  AssertionKind,
  AssertionOf,
  At,
  BackendFaults,
  CaseAssertion,
  Count,
  EvalCase,
  FaultToggle,
  FixtureOrder,
  Fixtures,
  PriorRefund,
  QuarantineEntry,
  RefundSelector,
  Step,
} from './case/schema.js';
export {
  CASES_DIR,
  QUARANTINE_FILE,
  loadEvalCase,
  loadEvalCases,
  loadQuarantine,
} from './case/loader.js';
export type { LoadedEvalCase } from './case/loader.js';

export type {
  AgentFactory,
  AgentTurnResult,
  AssertionOutcome,
  AssertionResult,
  CaseOutcome,
  CaseVerdict,
  EvalAgent,
  Observation,
  RefundedItems,
  RunClock,
  RunError,
  RunErrorKind,
  RunHandle,
  RunOutcome,
  RunSuiteConfig,
  RunTranscript,
  RunWorld,
  SuiteReport,
  TakeOver,
} from './run/types.js';
export { RunFailure, notImplemented } from './run/errors.js';
export { createRunClock } from './run/clock.js';
export { FIXTURE_STAMP, materializeFixtures } from './run/fixtures.js';
export type { MaterializedFixtures } from './run/fixtures.js';
export {
  buildObservation,
  resolveRefund,
  runCase,
  runOnce,
  runSuite,
  verdictFor,
} from './run/runner.js';

export { ASSERTIONS, evaluateAssertion } from './assertions/registry.js';
export type { AssertionFn, AssertionRegistry } from './assertions/registry.js';

export { assertionFailureCounts, exitCodeFor, formatSuiteReport } from './report/reporter.js';
