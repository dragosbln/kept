// HAND-WRITTEN (block 3): the run loop, the observation, the selector rule
// and the stability rule. The signatures and the tests with empty bodies
// are the skeleton; the bodies and the invariants land next.
//
// The ancestor is scripts/attack.ts: a fresh world per run, the steps
// replayed in order, the trace of each customer turn read off the sink
// after the turn, the ledger listed at the end. What it lacked is what this
// module adds: assertions over the observation, three repetitions folded
// by verdictFor, and the quarantine list applied in runSuite.

import type { RefundLedgerRecord, RefundLedgerRecordStatus } from '@kept-hq/core';
import type { EvalCase, QuarantineEntry, RefundSelector } from '../case/schema.js';
import { notImplemented } from './errors.js';
import type {
  AgentFactory,
  CaseOutcome,
  CaseVerdict,
  Observation,
  RunHandle,
  RunOutcome,
  RunSuiteConfig,
  RunTranscript,
  RunWorld,
  SuiteReport,
} from './types.js';

/**
 * One execution of one case in a fresh world: materialize the fixtures,
 * build the clock, call the factory, replay the steps, snapshot the
 * observation, evaluate every assertion. Classifies what is thrown by
 * position (decision 2): a factory throw is boot_failed, a turn whose
 * outcome is `failed` with reason `internal` is turn_internal, an operator
 * step the inbox refused is step_refused, a selector with zero or several
 * matches is selector_unresolved, anything else is unexpected. Always shuts
 * the agent down.
 */
export async function runOnce(
  evalCase: EvalCase,
  factory: AgentFactory,
  config: RunSuiteConfig,
): Promise<RunOutcome> {
  return notImplemented(`runOnce(${evalCase.id}, ${factory.name || 'factory'}, ${config.runs})`);
}

/**
 * The record an operator step or a policy_decision assertion means. Exactly
 * one record must match the selector among those in one of `statuses`;
 * zero or several is a RunFailure of kind selector_unresolved.
 */
export function resolveRefund(
  records: readonly RefundLedgerRecord[],
  selector: RefundSelector,
  statuses: readonly RefundLedgerRecordStatus[],
): RefundLedgerRecord {
  return notImplemented(
    `resolveRefund(${records.length}, ${selector.orderId}, ${statuses.length})`,
  );
}

/** The snapshot every assertion reads: the ledger listed once, the transcript, the world's facts, the clock at the end. */
export async function buildObservation(
  world: RunWorld,
  handle: RunHandle,
  transcript: RunTranscript,
): Promise<Observation> {
  return notImplemented(
    `buildObservation(${world.evalCase.id}, ${handle.traces.length}, ${transcript.timeline.length})`,
  );
}

/**
 * The stability rule (decision 1): every run passed is passed, every run
 * failed is failed, a disagreement is flaky, and any errored run voids the
 * case as error.
 */
export function verdictFor(runs: readonly RunOutcome[]): CaseVerdict {
  return notImplemented(`verdictFor(${runs.length})`);
}

/** `config.runs` executions of runOnce, folded by verdictFor. */
export async function runCase(
  evalCase: EvalCase,
  factory: AgentFactory,
  config: RunSuiteConfig,
): Promise<CaseOutcome> {
  return notImplemented(`runCase(${evalCase.id}, ${factory.name || 'factory'}, ${config.runs})`);
}

/**
 * Every case through runCase, in order; a case on the quarantine list runs
 * and reports with `quarantined: true` and never gates. The block-4 matrix
 * calls this once per toggle.
 */
export async function runSuite(
  cases: readonly EvalCase[],
  quarantine: readonly QuarantineEntry[],
  factory: AgentFactory,
  config: RunSuiteConfig,
): Promise<SuiteReport> {
  return notImplemented(
    `runSuite(${cases.length}, ${quarantine.length}, ${factory.name || 'factory'}, ${config.runs})`,
  );
}
