// HAND-WRITTEN (block 3): the run loop, the observation, the selector rule
// and the stability rule. The signatures and the tests with empty bodies
// are the skeleton; the bodies and the invariants land next.
//
// The ancestor is scripts/attack.ts: a fresh world per run, the steps
// replayed in order, the trace of each customer turn read off the sink
// after the turn, the ledger listed at the end. What it lacked is what this
// module adds: assertions over the observation, three repetitions folded
// by verdictFor, and the quarantine list applied in runSuite.

/* oxlint-disable no-await-in-loop -- steps, runs and cases are sequential by design */

import type { RefundLedgerRecord, RefundLedgerRecordStatus } from '@kept-hq/core';
import type { EvalCase, QuarantineEntry, RefundSelector, Step } from '../case/schema.js';
import { RunFailure } from './errors.js';
import type {
  AgentFactory,
  AssertionOutcome,
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
import { createRunClock } from './clock.js';
import { materializeFixtures, type MaterializedFixtures } from './fixtures.js';
import { evaluateAssertion } from '../assertions/registry.js';

async function runStep(
  step: Step,
  world: RunWorld,
  handle: RunHandle,
  transcript: RunTranscript,
): Promise<void> {
  const kind = step.kind;
  switch (kind) {
    case 'jump_clock': {
      world.clock.advance(step.byMs);
      return;
    }
    case 'customer_message': {
      const conversationId = transcript.conversationIds[step.conversation - 1];
      const initialSinkCount = handle.traces.length;
      const result = await handle.agent.handleNewMessage(step.message, conversationId);
      if (result.kind === 'conversation_not_found') {
        throw new RunFailure('unexpected', `Conversation id not found: ${conversationId}`);
      }
      if (handle.traces.length <= initialSinkCount) {
        throw new RunFailure('unexpected', 'Trace was not added to the handle after the run');
      }
      const trace = handle.traces.at(-1)!;
      transcript.timeline.push(trace);
      if (conversationId === undefined) {
        transcript.conversationIds.push(result.conversationId);
        transcript.traces.push([trace]);
      } else {
        transcript.traces[step.conversation - 1]!.push(trace);
      }
      if (result.outcome.type === 'failed' && result.outcome.reason === 'internal') {
        throw new RunFailure('turn_internal', 'handle message failed with internal reason');
      }
      return;
    }
    case 'human_takeover': {
      const conversationId = transcript.conversationIds[step.conversation - 1];
      if (conversationId === undefined) {
        throw new RunFailure('unexpected', `Conversation #${step.conversation} not found.`);
      }
      const result = await handle.agent.inbox.takeOver(conversationId, step.actor);
      if (result.status === 'refused') {
        throw new RunFailure('step_refused', `Take over refused: ${result.reason}`);
      }
      transcript.takeOvers.push({
        conversation: step.conversation,
        at: world.clock.now(),
        afterTurn: transcript.traces[step.conversation - 1]?.length ?? 0,
      });
      return;
    }
    case 'approve_refund': {
      const record = await resolveRefund(await handle.ledger.list(), step.refund, ['pending']);
      const result = await handle.agent.inbox.approve(record.id, step.actor);
      if (result.status === 'refused') {
        console.warn('YO PROBLEM!!', result);

        throw new RunFailure('step_refused', `Approve refund refused: ${result.reason}`);
      }
      return;
    }
    case 'deny_refund': {
      const record = await resolveRefund(await handle.ledger.list(), step.refund, ['pending']);
      const result = await handle.agent.inbox.deny(record.id, step.actor);
      if (result.status === 'refused') {
        throw new RunFailure('step_refused', `Deny refund refused: ${result.reason}`);
      }
      return;
    }
    case 'reconcile_refund': {
      const record = await resolveRefund(await handle.ledger.list(), step.refund, [
        'unknown',
        'attempted',
      ]);
      // in a run no tool call is in flight when an operator step executes, every turn has settled, so a zero window is the truthful value
      const RECONCILE_WINDOW = 0;
      const result = await handle.agent.inbox.reconcile(record.id, step.actor, RECONCILE_WINDOW);
      if (result.status === 'refused') {
        throw new RunFailure('step_refused', `Reconcile refund refused: ${result.reason}`);
      }
      return;
    }
    default:
      kind satisfies never;
      throw new RunFailure('unexpected', `Unrecognized step kind: ${kind}`);
  }
}

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
  const clock = createRunClock(evalCase.clock);

  let fixtures: MaterializedFixtures;

  try {
    fixtures = materializeFixtures(evalCase, clock.now());
  } catch (error) {
    return {
      status: 'error',
      error: new RunFailure('boot_failed', 'materializeFixtures failed', {
        cause: error,
      }).toRunError(),
      traceIds: [],
    };
  }

  const { orders, refundedItems, priorRefunds } = fixtures;

  const world: RunWorld = {
    evalCase,
    clock,
    orders,
    refundedItems,
    priorRefunds,
    policy: evalCase.fixtures.policy,
    backend: evalCase.fixtures.backend,
    faultToggles: config.faultToggles,
  };

  let handle: RunHandle;

  try {
    handle = await factory(world);
  } catch (error) {
    return {
      status: 'error',
      error: new RunFailure('boot_failed', 'handle factory failed', { cause: error }).toRunError(),
      traceIds: [],
    };
  }

  try {
    const mutableTranscript: RunTranscript = {
      conversationIds: [],
      traces: [],
      timeline: [],
      takeOvers: [],
    };

    let step: Step;
    for (step of evalCase.steps) {
      try {
        await runStep(step, world, handle, mutableTranscript);
      } catch (error) {
        const runFailure =
          error instanceof RunFailure
            ? error
            : new RunFailure('unexpected', `Run step failed at: ${step.kind}`, { cause: error });
        return {
          status: 'error',
          error: runFailure.toRunError(),
          traceIds: mutableTranscript.timeline.map((trace) => trace.id),
        };
      }
    }

    try {
      const observation = await buildObservation(world, handle, mutableTranscript);

      try {
        const assertionOutcomes: AssertionOutcome[] = evalCase.assertions
          .map((assertion) => evaluateAssertion(observation, assertion))
          .map((result, index) => ({
            id: evalCase.assertions[index]!.id,
            kind: evalCase.assertions[index]!.kind,
            result,
          }));

        return {
          status: assertionOutcomes.some((assrt) => !assrt.result.passed) ? 'failed' : 'passed',
          assertions: assertionOutcomes,
          traceIds: mutableTranscript.timeline.map((trace) => trace.id),
        };
      } catch (error) {
        console.log('err', error);

        return {
          status: 'error',
          error: new RunFailure('unexpected', 'Assertion threw an error', {
            cause: error,
          }).toRunError(),
          traceIds: mutableTranscript.timeline.map((trace) => trace.id),
        };
      }
    } catch (error) {
      return {
        status: 'error',
        error: new RunFailure('unexpected', 'buildObservation failed', {
          cause: error,
        }).toRunError(),
        traceIds: mutableTranscript.timeline.map((trace) => trace.id),
      };
    }
  } finally {
    await handle.agent.shutdown();
  }
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
  const filteredRecords = records.filter(
    (rec) =>
      rec.orderId === selector.orderId &&
      statuses.includes(rec.status) &&
      (!selector.orderItemId || selector.orderItemId === rec.orderItemId) &&
      (selector.quantity === undefined || selector.quantity === rec.quantity),
  );
  if (filteredRecords.length > 1) {
    throw new RunFailure(
      'selector_unresolved',
      `Multiple records were found for the selector: ${filteredRecords.length}`,
    );
  }
  if (!filteredRecords[0]) {
    throw new RunFailure('selector_unresolved', 'Ledger record not found');
  }
  return filteredRecords[0];
}

/** The snapshot every assertion reads: the ledger listed once, the transcript, the world's facts, the clock at the end. */
export async function buildObservation(
  world: RunWorld,
  handle: RunHandle,
  transcript: RunTranscript,
): Promise<Observation> {
  const records = await handle.ledger.list();
  return {
    ledger: records,
    traces: transcript.traces,
    timeline: transcript.timeline,
    conversationIds: transcript.conversationIds,
    takeOvers: transcript.takeOvers,
    orders: world.orders,
    declaredPolicy: world.policy,
    effectivePolicy: handle.effectivePolicy,
    clockAtEnd: world.clock.now(),
    faultToggles: world.faultToggles,
  };
}

/**
 * The stability rule (decision 1): every run passed is passed, every run
 * failed is failed, a disagreement is flaky, and any errored run voids the
 * case as error.
 */
export function verdictFor(runs: readonly RunOutcome[]): CaseVerdict {
  if (!runs.length) return 'error';
  if (runs.some((run) => run.status === 'error')) return 'error';
  if (runs.every((run) => run.status === 'passed')) return 'passed';
  if (runs.every((run) => run.status === 'failed')) return 'failed';
  return 'flaky';
}

/** `config.runs` executions of runOnce, folded by verdictFor. */
export async function runCase(
  evalCase: EvalCase,
  factory: AgentFactory,
  config: RunSuiteConfig,
): Promise<Omit<CaseOutcome, 'quarantined'>> {
  const runs: RunOutcome[] = [];

  for (let i = 0; i < config.runs; i++) {
    const runOutcome = await runOnce(evalCase, factory, config);
    runs.push(runOutcome);
    if (runOutcome.status === 'error') {
      // short-circuit, any errored run breaks the whole case
      return {
        caseId: evalCase.id,
        runs,
        verdict: verdictFor(runs),
      };
    }
  }

  return {
    caseId: evalCase.id,
    runs,
    verdict: verdictFor(runs),
  };
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
  const caseOutcomes: CaseOutcome[] = [];
  const startedAt = Date.now();

  for (const c of cases) {
    const outcome = await runCase(c, factory, config);
    caseOutcomes.push({
      caseId: outcome.caseId,
      runs: outcome.runs,
      verdict: outcome.verdict,
      quarantined: quarantine.some((entry) => entry.caseId === outcome.caseId),
    });
  }

  return {
    startedAt,
    finishedAt: Date.now(),
    config,
    cases: caseOutcomes,
  };
}
