// The runner's vocabulary: what a run is given, what it watches, what it
// produces. Assertions read an Observation and nothing else (ADR 0001).
//
// Three layers, one runner: runOnce executes a case once in a fresh world,
// runCase repeats it and applies the stability rule, runSuite iterates the
// cases and applies the quarantine list. The stability rule and the
// quarantine rule are suite policy; a case never knows it is run three
// times.

import type {
  CompletedTrace,
  InboxActions,
  Order,
  PolicyEngineConfig,
  RefundLedger,
  RefundLedgerRecord,
  TurnOutcome,
} from '@kept-hq/core';
import type { AssertionKind, BackendFaults, EvalCase, FaultToggle } from '../case/schema.js';

// --- The world --------------------------------------------------------------

/** The conversation clock of one run. `jump_clock` advances it; every clock reader in the host is fed `now`. */
export type RunClock = {
  now(): number;
  advance(byMs: number): void;
};

/** What the demo backend has already refunded per line before the run: `{ [orderId]: { [orderItemId]: quantity } }`. */
export type RefundedItems = Record<string, Record<string, number>>;

/** Materialized fixtures for one run: everything the factory needs to build a fresh world. */
export type RunWorld = {
  readonly evalCase: EvalCase;
  readonly clock: RunClock;
  readonly orders: readonly Order[];
  readonly refundedItems: RefundedItems;
  readonly priorRefunds: readonly RefundLedgerRecord[];
  /** The declared policy, from the case. */
  readonly policy: PolicyEngineConfig;
  readonly backend: BackendFaults;
  readonly faultToggles: readonly FaultToggle[];
};

/** The host's turn result, structurally: what the agent app's service returns. */
export type AgentTurnResult =
  { kind: 'ok'; conversationId: string; outcome: TurnOutcome } | { kind: 'conversation_not_found' };

/** The slice of the agent service a run drives: turns, the inbox for operator steps, and shutdown. */
export type EvalAgent = {
  handleNewMessage(message: string, conversationId?: string): Promise<AgentTurnResult>;
  readonly inbox: InboxActions;
  shutdown(): Promise<void>;
};

/** What the factory hands back: the agent, and the two things a run reads at the end. */
export type RunHandle = {
  readonly agent: EvalAgent;
  /**
   * Every completed trace the host exported, in export order. The host
   * exports a turn's trace before handleNewMessage resolves, so the last
   * entry after a customer step is that step's trace.
   */
  readonly traces: readonly CompletedTrace[];
  readonly ledger: RefundLedger;
  /** What the engine actually ran with; equals the declared policy until a block-4 toggle filters it. */
  readonly effectivePolicy: PolicyEngineConfig;
};

/**
 * Builds a fresh world for one run. Lives in the host, not here: the host
 * knows how to compose a service, and the sealed package must not import
 * the app (its config reader reads LANGFUSE_*; ADR 0001).
 */
export type AgentFactory = (world: RunWorld) => Promise<RunHandle>;

// --- What a run watches -----------------------------------------------------

/**
 * One human_takeover step. `afterTurn` is how many turns the conversation
 * had at that moment: the marker assertions use, because trace timestamps
 * are wall clock and the run clock is not. `at` is the run clock, for the
 * report.
 */
export type TakeOver = { conversation: number; afterTurn: number; at: number };

/** What the runner accumulates while stepping; the observation is built from it and the ledger at the end. */
export type RunTranscript = {
  /** Index = conversation ordinal − 1. */
  conversationIds: string[];
  /** traces[c − 1][t − 1]: the trace of turn t of conversation c. */
  traces: CompletedTrace[][];
  /** Every trace in step order, across conversations. */
  timeline: CompletedTrace[];
  takeOvers: TakeOver[];
};

/**
 * The input of every assertion: a synchronous snapshot, taken once after
 * the last step. Nothing here is a port and nothing is read lazily.
 */
export type Observation = {
  readonly ledger: readonly RefundLedgerRecord[];
  readonly traces: readonly (readonly CompletedTrace[])[];
  readonly timeline: readonly CompletedTrace[];
  readonly conversationIds: readonly string[];
  readonly takeOvers: readonly TakeOver[];
  readonly orders: readonly Order[];
  /** What the merchant declared: what composed_cap_sum checks against. */
  readonly declaredPolicy: PolicyEngineConfig;
  /** What the engine ran with; differs from declared only under a toggle. For the report. */
  readonly effectivePolicy: PolicyEngineConfig;
  /** The clock after the last step; the window floor of a windowed cap is computed from it. */
  readonly clockAtEnd: number;
  readonly faultToggles: readonly FaultToggle[];
};

// --- What a run produces ----------------------------------------------------

export type AssertionResult =
  | { passed: true }
  | {
      passed: false;
      /** What was found instead: printed by the reporter, read at 11 pm when the matrix is red. */
      reason: string;
      traceId?: string;
    };

export type AssertionOutcome = {
  id: string;
  kind: AssertionKind;
  result: AssertionResult;
};

/**
 * Why a run produced no verdict. Errors are infrastructure, never the
 * agent: anything the trace records as the agent's outcome is assertable;
 * anything thrown outside a turn, and a turn that fails with reason
 * `internal`, is an error (decision 2).
 */
export type RunErrorKind =
  'boot_failed' | 'turn_internal' | 'step_refused' | 'selector_unresolved' | 'unexpected';

export type RunError = { kind: RunErrorKind; message: string; cause?: unknown };

export type RunOutcome =
  | {
      status: 'passed' | 'failed';
      /** Every assertion, passed ones included: the matrix maps expected reds per assertion. */
      assertions: AssertionOutcome[];
      traceIds: string[];
    }
  | { status: 'error'; error: RunError; traceIds: string[] };

/**
 * The stability rule: all runs passed, all failed, they disagree, or any
 * run errored, in which case the case has no verdict. Red is failed or
 * flaky; error fails the job but is not a matrix signal (decision 1).
 */
export type CaseVerdict = 'passed' | 'failed' | 'flaky' | 'error';

export type CaseOutcome = {
  caseId: string;
  verdict: CaseVerdict;
  runs: RunOutcome[];
  /** Ran and reported, never gated. */
  quarantined: boolean;
};

export type RunSuiteConfig = {
  /** Repetitions per case; 3 is the stability rule. */
  runs: number;
  faultToggles: readonly FaultToggle[];
};

export type SuiteReport = {
  startedAt: number;
  finishedAt: number;
  config: RunSuiteConfig;
  cases: CaseOutcome[];
};
