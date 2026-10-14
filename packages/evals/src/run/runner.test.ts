// HAND-WRITTEN (block 3): the run loop and the stability rule. The names
// below are the invariants the sketch pins; the bodies land with the
// runner. A fake factory over an in-memory agent is the intended harness:
// no model, no Postgres, the trace and the ledger scripted per test.

import { describe, expect, it } from 'vitest';
import {
  buildObservation,
  resolveRefund,
  runCase,
  runOnce,
  runSuite,
  verdictFor,
} from './runner.js';
import { parseEvalCase } from '../case/schema.js';
import {
  DemoBackend,
  InboxService,
  InMemoryAuditLog,
  InMemoryConversationStore,
  InMemoryRefundLedger,
  Trace,
  type CompletedTrace,
  type PolicyEngineConfig,
  type RefundLedgerRecord,
  type TurnOutcome,
} from '@kept-hq/core';
import type {
  AgentFactory,
  EvalAgent,
  RunHandle,
  RunOutcome,
  RunSuiteConfig,
  RunWorld,
} from './types.js';
import { materializeFixtures } from './fixtures.js';
import { createRunClock } from './clock.js';
import { RunFailure } from './errors.js';

// const NOW = Date.UTC(2026, 8, 10, 12);
const DAY = 86_400_000;

const base = {
  id: 'fixtures',
  title: 'Fixtures',
  storeId: 'loomhaven',
  clock: '2026-09-10T12:00:00Z',
  steps: [{ kind: 'customer_message', message: 'hi' }],
  assertions: [{ kind: 'turn_outcome', expected: { type: 'reply' } }],
};

type FactorySink = {
  world: RunWorld;
  handle: RunHandle;
};

function fakeFactory(
  script: (message: string) => TurnOutcome,
  sink: FactorySink[] = [],
): AgentFactory {
  return async (world) => {
    const traces: CompletedTrace[] = [];
    const store = new InMemoryConversationStore();
    const ledger = new InMemoryRefundLedger([...world.priorRefunds], () => world.clock.now());
    const backend = new DemoBackend([...world.orders], structuredClone(world.refundedItems), () =>
      world.clock.now(),
    );
    const inbox = new InboxService({
      ledger,
      backend,
      store,
      audit: new InMemoryAuditLog(),
      now: () => world.clock.now(),
    });
    const agent: EvalAgent = {
      inbox,
      shutdown: async () => {},
      async handleNewMessage(message, conversationId) {
        const id = conversationId ?? (await store.createNewConversation()).id;
        const trace = new Trace({
          sessionId: id,
          providerName: 'fake',
          promptName: 'main-agent',
          promptVersion: '0',
          promptHash: 'fake',
          backendKind: 'demo',
        });
        const turn = trace.startTurnSpan(null, { customerInput: message });
        const outcome = script(message);
        turn.end({ outcome });
        traces.push(trace.end()); // before resolving, as the host does
        return { kind: 'ok', conversationId: id, outcome };
      },
    };
    const handle = { agent, traces, ledger, effectivePolicy: world.policy };
    sink.push({
      world,
      handle,
    });
    return handle;
  };
}

// --- A scripted agent, for the error paths and the transcript ---------------------

const ONCE: RunSuiteConfig = { runs: 1, faultToggles: [] };

/** An in-memory ledger that counts how often it is listed: the observation must list it once. */
class CountingLedger extends InMemoryRefundLedger {
  lists = 0;

  override async list(): Promise<RefundLedgerRecord[]> {
    this.lists += 1;
    return super.list();
  }
}

type Probe = {
  world: RunWorld;
  handle: RunHandle;
  store: InMemoryConversationStore;
  ledger: CountingLedger;
  /** What the runner passed to handleNewMessage, in order. */
  calls: { message: string; conversationId: string | undefined }[];
  /** The conversation ids the agent opened, in order. */
  opened: string[];
  shutdowns: number;
};

type ScriptedOptions = {
  /** The outcome of each turn; the default replies with an echo of the message. */
  outcome?: (message: string, turnIndex: number) => TurnOutcome;
  /** Every turn asks the model once, like the host; false for an agent that never does. */
  modelCall?: boolean;
  /** Thrown by the factory itself. */
  bootError?: Error;
  /** Thrown by handleNewMessage, outside any trace. */
  turnError?: Error;
  /** false: the agent never exports the turn's trace, which the host always does. */
  exportTrace?: boolean;
};

/** One probe per factory call, so runCase's fresh worlds can be told apart. */
function scriptedFactory(options: ScriptedOptions = {}): {
  factory: AgentFactory;
  probes: Probe[];
} {
  const probes: Probe[] = [];
  const factory: AgentFactory = async (world) => {
    if (options.bootError) throw options.bootError;
    const now = (): number => world.clock.now();
    const traces: CompletedTrace[] = [];
    const store = new InMemoryConversationStore();
    const ledger = new CountingLedger([...world.priorRefunds], now);
    const backend = new DemoBackend([...world.orders], structuredClone(world.refundedItems), now);
    const inbox = new InboxService({
      ledger,
      backend,
      store,
      audit: new InMemoryAuditLog(now),
      now,
    });
    const calls: Probe['calls'] = [];
    const opened: string[] = [];
    let shutdowns = 0;
    let turnIndex = 0;
    const agent: EvalAgent = {
      inbox,
      shutdown: async () => {
        shutdowns += 1;
        probe.shutdowns = shutdowns;
      },
      async handleNewMessage(message, conversationId) {
        calls.push({ message, conversationId });
        if (options.turnError) throw options.turnError;
        const id = conversationId ?? (await store.createNewConversation()).id;
        if (conversationId === undefined) opened.push(id);
        const trace = new Trace({
          sessionId: id,
          providerName: 'fake',
          promptName: 'main-agent',
          promptVersion: '0',
          promptHash: 'fake',
          backendKind: 'demo',
        });
        const turn = trace.startTurnSpan(null, { customerInput: message });
        if (options.modelCall !== false) {
          trace
            .startModelCallSpan(turn.id, {
              promptName: 'main-agent',
              promptVersion: '0',
              promptHash: 'fake',
              providerName: 'fake',
              model: 'fake-model',
              inputMessages: [],
            })
            .end({});
        }
        const outcome = options.outcome?.(message, turnIndex++) ?? {
          type: 'reply',
          message: `echo: ${message}`,
        };
        turn.end({ outcome });
        const completed = trace.end();
        if (options.exportTrace !== false) traces.push(completed);
        return { kind: 'ok', conversationId: id, outcome };
      },
    };
    const handle: RunHandle = { agent, traces, ledger, effectivePolicy: world.policy };
    const probe: Probe = { world, handle, store, ledger, calls, opened, shutdowns };
    probes.push(probe);
    return handle;
  };
  return { factory, probes };
}

function errorOf(outcome: RunOutcome): { kind: string; message: string } {
  if (outcome.status !== 'error')
    throw new Error(`expected an error outcome, got ${outcome.status}`);
  return outcome.error;
}

describe('runOnce', () => {
  it('builds a fresh world per run: the factory is called once, with the materialized fixtures and a clock at the case clock', async () => {
    const sink: FactorySink[] = [];
    const evalCase = parseEvalCase(base);
    await runOnce(
      evalCase,
      fakeFactory((_message) => ({ type: 'reply', message: 'success' }), sink),
      {
        faultToggles: [],
        runs: 1,
      },
    );

    expect(sink.length).toEqual(1);
    expect(sink[0]!.world.clock.now()).toBe(evalCase.clock);

    const materialized = materializeFixtures(evalCase, evalCase.clock);

    expect(sink[0]!.world.orders).toEqual(materialized.orders);
    expect(sink[0]!.world.refundedItems).toEqual(materialized.refundedItems);
    expect(sink[0]!.world.priorRefunds).toEqual(materialized.priorRefunds);
  });
  it('maps each customer turn to the trace exported during that call, by conversation ordinal and turn', async () => {
    const CONVERSATION_1 = 'hi from conversation_1';
    const CONVERSATION_2 = 'hi from conversation_2';

    const evalCase = parseEvalCase({
      ...base,
      steps: [
        { kind: 'customer_message', message: CONVERSATION_1 },
        { kind: 'customer_message', message: CONVERSATION_2, conversation: 2 },
      ],
      assertions: [
        {
          kind: 'reply_contains',
          strings: [CONVERSATION_2],
          mode: 'all',
          at: { conversation: 2, turn: 1 },
        },
      ],
    });
    const result = await runOnce(
      evalCase,
      fakeFactory((message) => ({ type: 'reply', message: `echo: ${message}` })),
      {
        faultToggles: [],
        runs: 1,
      },
    );

    expect(result.status).toEqual('passed');
  });
  it('opens a conversation the first time its ordinal appears and continues it afterwards', async () => {
    const evalCase = parseEvalCase({
      ...base,
      steps: [
        { kind: 'customer_message', conversation: 1, message: 'one' },
        { kind: 'customer_message', conversation: 2, message: 'two' },
        { kind: 'customer_message', conversation: 1, message: 'one again' },
        { kind: 'customer_message', conversation: 2, message: 'two again' },
      ],
    });
    const { factory, probes } = scriptedFactory();
    const outcome = await runOnce(evalCase, factory, ONCE);

    expect(outcome.status).toBe('passed');
    const [probe] = probes;
    expect(probe!.opened).toHaveLength(2);
    expect(probe!.calls.map((call) => call.conversationId)).toEqual([
      undefined,
      undefined,
      probe!.opened[0],
      probe!.opened[1],
    ]);
    // Four turns, two per conversation, each trace under its own session.
    expect(probe!.handle.traces.map((trace) => trace.sessionId)).toEqual([
      probe!.opened[0],
      probe!.opened[1],
      probe!.opened[0],
      probe!.opened[1],
    ]);
  });
  it('jump_clock advances the clock the factory received and nothing else', async () => {
    const evalCase = parseEvalCase({
      ...base,
      steps: [
        { kind: 'customer_message', message: 'hi' },
        { kind: 'jump_clock', byMs: DAY },
        { kind: 'human_takeover', conversation: 1 },
      ],
      assertions: [{ kind: 'no_model_call_after_takeover', conversation: 1 }],
    });
    const { factory, probes } = scriptedFactory();
    const outcome = await runOnce(evalCase, factory, ONCE);

    expect(outcome.status).toBe('passed');
    const [probe] = probes;
    expect(probe!.world.clock.now()).toBe(evalCase.clock + DAY);
    // The inbox reads the same clock: the take-over mark carries the advanced time.
    const conversation = await probe!.store.findConversation(probe!.opened[0]!);
    expect(conversation?.takeOver?.takenOverAt).toBe(evalCase.clock + DAY);
    // The fixtures were materialized at the case clock and do not move with it.
    expect(probe!.world.orders).toEqual(materializeFixtures(evalCase, evalCase.clock).orders);
  });
  it('an operator step resolves its selector against the live ledger and calls the inbox with the actor', async () => {
    const sink: FactorySink[] = [];

    const targetRefund = {
      orderId: 'order-1005',
      orderItemId: 'order-1005-line-1',
      quantity: 1,
      status: 'pending',
      ageMs: 5 * DAY,
    };

    const otherRefund = {
      orderId: 'order-1002',
      orderItemId: 'order-1002-line-2',
      quantity: 1,
      status: 'pending',
      ageMs: DAY,
    };

    const evalCase = parseEvalCase({
      ...base,
      fixtures: {
        priorRefunds: [otherRefund, targetRefund],
      },
      steps: [
        {
          kind: 'approve_refund',
          refund: {
            orderId: targetRefund.orderId,
            orderItemId: targetRefund.orderItemId,
            quantity: targetRefund.quantity,
          },
          actor: 'test',
        },
      ],
      assertions: [
        {
          kind: 'ledger_records',
          where: {
            orderId: targetRefund.orderId,
            orderItemId: targetRefund.orderItemId,
            quantity: targetRefund.quantity,
            status: ['ok'],
          },
          count: {
            eq: 1,
          },
        },
        {
          kind: 'ledger_records',
          where: {
            orderId: otherRefund.orderId,
            orderItemId: otherRefund.orderItemId,
            quantity: otherRefund.quantity,
            status: ['pending'],
          },
          count: {
            eq: 1,
          },
        },
      ],
    });

    const result = await runOnce(
      evalCase,
      fakeFactory((_message) => ({ type: 'reply', message: 'success' }), sink),
      {
        faultToggles: [],
        runs: 1,
      },
    );

    expect(result.status).toEqual('passed');
    expect(sink.length).toEqual(1);

    const auditList = await sink[0]!.handle.agent.inbox.listAudit();
    const approvedAction = auditList.find((adt) => adt.action === 'approve');
    expect(approvedAction).toBeDefined();
    expect(approvedAction!.actor).toEqual('test');
  });
  it('a take-over is recorded with the conversation ordinal, the turns it had so far, and the run clock', async () => {
    // The scripted agent asks the model on every turn, take-over or not, so
    // the assertion is red exactly when a turn of the taken-over
    // conversation comes after the mark.
    const after = parseEvalCase({
      ...base,
      steps: [
        { kind: 'customer_message', conversation: 1, message: 'a' },
        { kind: 'customer_message', conversation: 1, message: 'b' },
        { kind: 'human_takeover', conversation: 1 },
        { kind: 'customer_message', conversation: 1, message: 'c' },
      ],
      assertions: [{ kind: 'no_model_call_after_takeover', conversation: 1 }],
    });
    const red = await runOnce(after, scriptedFactory().factory, ONCE);
    expect(red.status).toBe('failed');
    if (red.status === 'error') throw new Error('unexpected error');
    expect(red.assertions[0]?.result).toMatchObject({ passed: false });
    if (red.assertions[0]!.result.passed) throw new Error('expected a failure');
    expect(red.assertions[0]!.result.reason).toMatch(/model call/);

    // The ordinal matters: conversation 1 keeps talking to the model after
    // conversation 2 was taken over, and only conversation 2 is checked.
    const otherConversation = parseEvalCase({
      ...base,
      steps: [
        { kind: 'customer_message', conversation: 1, message: 'a' },
        { kind: 'customer_message', conversation: 2, message: 'b' },
        { kind: 'human_takeover', conversation: 2 },
        { kind: 'customer_message', conversation: 1, message: 'c' },
      ],
      assertions: [{ kind: 'no_model_call_after_takeover', conversation: 2 }],
    });
    const green = await runOnce(otherConversation, scriptedFactory().factory, ONCE);
    expect(green.status).toBe('passed');
  });
  it('the observation is taken once after the last step and every assertion runs against it', async () => {
    const evalCase = parseEvalCase({
      ...base,
      steps: [
        { kind: 'customer_message', message: 'a' },
        { kind: 'customer_message', message: 'b' },
      ],
      assertions: [
        { id: 'red', kind: 'ledger_records', count: { eq: 99 } },
        { id: 'green-1', kind: 'ledger_records', count: { eq: 0 } },
        { id: 'green-2', kind: 'turn_outcome', expected: { type: 'reply' } },
      ],
    });
    const { factory, probes } = scriptedFactory();
    const outcome = await runOnce(evalCase, factory, ONCE);

    expect(outcome.status).toBe('failed');
    if (outcome.status === 'error') throw new Error('unexpected error');
    // No short-circuit on the first red: every assertion is evaluated and reported.
    expect(outcome.assertions.map((a) => [a.id, a.result.passed])).toEqual([
      ['red', false],
      ['green-1', true],
      ['green-2', true],
    ]);
    // No operator step listed the ledger, so the one list is the snapshot.
    expect(probes[0]!.ledger.lists).toBe(1);
  });
  it('a factory throw is an error of kind boot_failed', async () => {
    const evalCase = parseEvalCase(base);
    const { factory, probes } = scriptedFactory({ bootError: new Error('no database') });
    const outcome = await runOnce(evalCase, factory, ONCE);

    expect(errorOf(outcome)).toMatchObject({ kind: 'boot_failed' });
    expect(outcome.traceIds).toEqual([]);
    expect(probes).toHaveLength(0);

    // A fixture that cannot be materialized fails the same way, before the factory.
    const badFixture = parseEvalCase({
      ...base,
      fixtures: {
        priorRefunds: [
          { orderId: 'order-9', orderItemId: 'x', quantity: 1, status: 'ok', ageMs: 0 },
        ],
      },
    });
    const notBuilt = scriptedFactory();
    const fixtureOutcome = await runOnce(badFixture, notBuilt.factory, ONCE);
    expect(errorOf(fixtureOutcome)).toMatchObject({ kind: 'boot_failed' });
    expect(notBuilt.probes).toHaveLength(0);
  });
  it('a turn that fails with reason internal is an error of kind turn_internal; max_rounds and refusal are assertable outcomes', async () => {
    const internal = scriptedFactory({ outcome: () => ({ type: 'failed', reason: 'internal' }) });
    const errored = await runOnce(parseEvalCase(base), internal.factory, ONCE);
    expect(errorOf(errored)).toMatchObject({ kind: 'turn_internal' });
    // The failing turn's trace is captured before the turn is classified.
    expect(errored.traceIds).toHaveLength(1);
    expect(internal.probes[0]!.shutdowns).toBe(1);

    // max_rounds and refusal are the agent's own outcomes: assertable, never errors.
    const assertable = (['max_rounds', 'refusal'] as const).map(async (reason) => {
      const evalCase = parseEvalCase({
        ...base,
        assertions: [{ kind: 'turn_outcome', expected: { type: 'failed', reason } }],
      });
      const { factory } = scriptedFactory({ outcome: () => ({ type: 'failed', reason }) });
      return [reason, (await runOnce(evalCase, factory, ONCE)).status] as const;
    });
    expect(await Promise.all(assertable)).toEqual([
      ['max_rounds', 'passed'],
      ['refusal', 'passed'],
    ]);
  });
  it('an inbox refusal on an operator step is an error of kind step_refused', async () => {
    const evalCase = parseEvalCase({
      ...base,
      steps: [
        { kind: 'customer_message', message: 'hi' },
        { kind: 'human_takeover', conversation: 1 },
        { kind: 'human_takeover', conversation: 1 },
      ],
    });
    const { factory, probes } = scriptedFactory();
    const outcome = await runOnce(evalCase, factory, ONCE);

    expect(errorOf(outcome)).toMatchObject({ kind: 'step_refused' });
    expect(errorOf(outcome).message).toMatch(/already_taken_over/);
    expect(outcome.traceIds).toHaveLength(1);
    expect(probes[0]!.shutdowns).toBe(1);
  });
  it('a selector that matches no record, or several, is an error of kind selector_unresolved', async () => {
    const none = parseEvalCase({
      ...base,
      steps: [{ kind: 'approve_refund', refund: { orderId: 'order-1002' } }],
    });
    const noneOutcome = await runOnce(none, scriptedFactory().factory, ONCE);
    expect(errorOf(noneOutcome)).toMatchObject({ kind: 'selector_unresolved' });

    const pending = { quantity: 1, status: 'pending', ageMs: DAY };
    const several = parseEvalCase({
      ...base,
      fixtures: {
        priorRefunds: [
          { orderId: 'order-1002', orderItemId: 'order-1002-line-1', ...pending },
          { orderId: 'order-1002', orderItemId: 'order-1002-line-2', ...pending },
        ],
      },
      steps: [{ kind: 'approve_refund', refund: { orderId: 'order-1002' } }],
    });
    const severalOutcome = await runOnce(several, scriptedFactory().factory, ONCE);
    expect(errorOf(severalOutcome)).toMatchObject({ kind: 'selector_unresolved' });
    expect(errorOf(severalOutcome).message).toMatch(/2/);
  });
  it('anything else thrown is an error of kind unexpected, and the agent is still shut down', async () => {
    const thrown = scriptedFactory({ turnError: new Error('socket hang up') });
    const outcome = await runOnce(parseEvalCase(base), thrown.factory, ONCE);
    expect(errorOf(outcome)).toMatchObject({ kind: 'unexpected' });
    expect(thrown.probes[0]!.shutdowns).toBe(1);

    // An agent that resolves without exporting a trace breaks the turn-to-trace
    // mapping; the runner refuses to guess which trace is which.
    const silent = scriptedFactory({ exportTrace: false });
    const silentOutcome = await runOnce(parseEvalCase(base), silent.factory, ONCE);
    expect(errorOf(silentOutcome)).toMatchObject({ kind: 'unexpected' });
    expect(errorOf(silentOutcome).message).toMatch(/trace/i);
    expect(silent.probes[0]!.shutdowns).toBe(1);
  });
  it('the outcome carries every assertion, passed ones included, and the trace ids of the run', async () => {
    const evalCase = parseEvalCase({
      ...base,
      steps: [
        { kind: 'customer_message', message: 'a' },
        { kind: 'customer_message', message: 'b' },
      ],
      assertions: [
        { id: 'echoes', kind: 'reply_contains', strings: ['echo: b'] },
        { id: 'never', kind: 'reply_contains', strings: ['nothing like this'] },
      ],
    });
    const { factory, probes } = scriptedFactory();
    const outcome = await runOnce(evalCase, factory, ONCE);

    expect(outcome.status).toBe('failed');
    if (outcome.status === 'error') throw new Error('unexpected error');
    expect(outcome.assertions).toMatchObject([
      { id: 'echoes', kind: 'reply_contains', result: { passed: true } },
      { id: 'never', kind: 'reply_contains', result: { passed: false } },
    ]);
    expect(outcome.traceIds).toEqual(probes[0]!.handle.traces.map((trace) => trace.id));
    expect(outcome.traceIds).toHaveLength(2);
  });
});

describe('resolveRefund', () => {
  const pending = { quantity: 1, status: 'pending' as const, ageMs: DAY };
  const records = materializeFixtures(
    parseEvalCase({
      ...base,
      fixtures: {
        priorRefunds: [
          { orderId: 'order-1002', orderItemId: 'order-1002-line-1', ...pending },
          { orderId: 'order-1002', orderItemId: 'order-1002-line-2', ...pending },
          { orderId: 'order-1005', orderItemId: 'order-1005-line-1', ...pending, status: 'ok' },
        ],
      },
    }),
    Date.UTC(2026, 8, 10, 12),
  ).priorRefunds;

  it('exactly one record matching the selector among the given statuses is returned', () => {
    const byLine = resolveRefund(
      records,
      { orderId: 'order-1002', orderItemId: 'order-1002-line-2' },
      ['pending'],
    );
    expect(byLine.orderItemId).toBe('order-1002-line-2');
    // The statuses narrow before the selector: order-1005 is the only ok record.
    expect(resolveRefund(records, { orderId: 'order-1005' }, ['ok']).orderId).toBe('order-1005');
  });
  it('zero matches is a RunFailure of kind selector_unresolved that names the selector', () => {
    const attempt = (): RefundLedgerRecord =>
      resolveRefund(records, { orderId: 'order-1005' }, ['pending']);
    expect(attempt).toThrow(RunFailure);
    try {
      attempt();
    } catch (error) {
      expect(error).toBeInstanceOf(RunFailure);
      expect((error as RunFailure).kind).toBe('selector_unresolved');
      expect((error as RunFailure).message).toMatch(/not found/);
    }
  });
  it('several matches is a RunFailure of kind selector_unresolved that says how many', () => {
    try {
      resolveRefund(records, { orderId: 'order-1002' }, ['pending']);
      throw new Error('expected a throw');
    } catch (error) {
      expect(error).toBeInstanceOf(RunFailure);
      expect((error as RunFailure).kind).toBe('selector_unresolved');
      expect((error as RunFailure).message).toMatch(/2/);
    }
  });
});

describe('buildObservation', () => {
  const evalCase = parseEvalCase({
    ...base,
    fixtures: {
      priorRefunds: [
        {
          orderId: 'order-1005',
          orderItemId: 'order-1005-line-1',
          quantity: 1,
          status: 'ok',
          ageMs: DAY,
        },
      ],
    },
  });
  const effective: PolicyEngineConfig = { version: 'effective', caps: [] };

  function world(): RunWorld {
    const clock = createRunClock(evalCase.clock);
    const fixtures = materializeFixtures(evalCase, clock.now());
    return {
      evalCase,
      clock,
      ...fixtures,
      policy: evalCase.fixtures.policy,
      backend: evalCase.fixtures.backend,
      faultToggles: ['stale-kb'],
    };
  }

  function handleOver(current: RunWorld): { handle: RunHandle; ledger: CountingLedger } {
    const ledger = new CountingLedger([...current.priorRefunds], () => current.clock.now());
    const agent: EvalAgent = {
      inbox: undefined as never,
      shutdown: async () => {},
      handleNewMessage: async () => ({ kind: 'conversation_not_found' }),
    };
    return { ledger, handle: { agent, traces: [], ledger, effectivePolicy: effective } };
  }

  const emptyTranscript = { conversationIds: ['c-1'], traces: [[]], timeline: [], takeOvers: [] };

  it('lists the ledger once and copies the transcript; nothing in the observation is a port', async () => {
    const current = world();
    const { handle, ledger } = handleOver(current);
    const observation = await buildObservation(current, handle, {
      ...emptyTranscript,
      takeOvers: [{ conversation: 1, afterTurn: 0, at: current.clock.now() }],
    });

    expect(ledger.lists).toBe(1);
    expect(observation.ledger).toEqual(await ledger.list());
    expect(Array.isArray(observation.ledger)).toBe(true);
    expect(observation.conversationIds).toEqual(['c-1']);
    expect(observation.takeOvers).toEqual([{ conversation: 1, afterTurn: 0, at: evalCase.clock }]);
    expect(observation.orders).toEqual(current.orders);
    expect(observation.faultToggles).toEqual(['stale-kb']);
  });
  it('carries the declared policy from the case and the effective policy from the handle', async () => {
    const current = world();
    const observation = await buildObservation(
      current,
      handleOver(current).handle,
      emptyTranscript,
    );

    expect(observation.declaredPolicy).toBe(evalCase.fixtures.policy);
    expect(observation.effectivePolicy).toBe(effective);
    expect(observation.effectivePolicy).not.toEqual(observation.declaredPolicy);
  });
  it('the clock at the end is the clock after the last step', async () => {
    const current = world();
    current.clock.advance(3 * DAY);
    const observation = await buildObservation(
      current,
      handleOver(current).handle,
      emptyTranscript,
    );

    expect(observation.clockAtEnd).toBe(evalCase.clock + 3 * DAY);
  });
});

describe('verdictFor (the stability rule)', () => {
  const passed: RunOutcome = { status: 'passed', assertions: [], traceIds: [] };
  const failed: RunOutcome = { status: 'failed', assertions: [], traceIds: [] };
  const errored: RunOutcome = {
    status: 'error',
    error: { kind: 'boot_failed', message: 'x' },
    traceIds: [],
  };

  it('every run passed is passed', () => {
    expect(verdictFor([passed, passed, passed])).toBe('passed');
    expect(verdictFor([passed])).toBe('passed');
  });
  it('every run failed is failed', () => {
    expect(verdictFor([failed, failed, failed])).toBe('failed');
  });
  it('any disagreement between passed and failed is flaky', () => {
    expect(verdictFor([passed, failed, passed])).toBe('flaky');
    expect(verdictFor([failed, failed, passed])).toBe('flaky');
  });
  it('any errored run voids the case: the verdict is error whatever the other runs did', () => {
    expect(verdictFor([passed, passed, errored])).toBe('error');
    expect(verdictFor([errored, failed])).toBe('error');
  });
  it('no runs is an error, not a pass', () => {
    expect(verdictFor([])).toBe('error');
  });
});

describe('runCase', () => {
  it('runs the case config.runs times, each in a fresh world', async () => {
    const evalCase = parseEvalCase(base);
    const { factory, probes } = scriptedFactory();
    const outcome = await runCase(evalCase, factory, { runs: 3, faultToggles: [] });

    expect(outcome.caseId).toBe(evalCase.id);
    expect(outcome.runs).toHaveLength(3);
    expect(probes).toHaveLength(3);
    // Nothing is shared between runs: three clocks, three order lists, three shutdowns.
    expect(new Set(probes.map((probe) => probe.world.clock)).size).toBe(3);
    expect(new Set(probes.map((probe) => probe.world.orders)).size).toBe(3);
    expect(probes.map((probe) => probe.shutdowns)).toEqual([1, 1, 1]);
  });
  it('folds the runs with verdictFor and keeps every run outcome', async () => {
    const evalCase = parseEvalCase({
      ...base,
      assertions: [{ kind: 'reply_contains', strings: ['yes'] }],
    });
    let run = 0;
    const alternating = scriptedFactory({
      outcome: () => ({ type: 'reply', message: run++ % 2 === 0 ? 'yes' : 'no' }),
    });
    const flaky = await runCase(evalCase, alternating.factory, { runs: 3, faultToggles: [] });
    expect(flaky.verdict).toBe('flaky');
    expect(flaky.runs.map((r) => r.status)).toEqual(['passed', 'failed', 'passed']);

    // An errored run stops the case there: no model calls are spent on a void verdict.
    let boots = 0;
    const failing: AgentFactory = async (world) => {
      boots += 1;
      if (boots === 2) throw new Error('second boot refused');
      return scriptedFactory().factory(world);
    };
    const voided = await runCase(evalCase, failing, { runs: 3, faultToggles: [] });
    expect(voided.verdict).toBe('error');
    expect(voided.runs.map((r) => r.status)).toEqual(['failed', 'error']);
  });
});

describe('runSuite', () => {
  const a = parseEvalCase({ ...base, id: 'a-case' });
  const b = parseEvalCase({
    ...base,
    id: 'b-case',
    assertions: [{ kind: 'reply_contains', strings: ['never'] }],
  });
  const quarantine = [{ caseId: 'b-case', since: '2026-10-13', reason: 'flaked on 10-12' }];
  const config: RunSuiteConfig = { runs: 2, faultToggles: ['caps-per-call-only'] };

  it('runs every case in order and returns one outcome per case', async () => {
    const { factory, probes } = scriptedFactory();
    const report = await runSuite([a, b], [], factory, config);

    expect(report.cases.map((outcome) => [outcome.caseId, outcome.verdict])).toEqual([
      ['a-case', 'passed'],
      ['b-case', 'failed'],
    ]);
    expect(probes.map((probe) => probe.world.evalCase.id)).toEqual([
      'a-case',
      'a-case',
      'b-case',
      'b-case',
    ]);
  });
  it('a quarantined case runs and is reported with quarantined: true', async () => {
    const report = await runSuite([a, b], quarantine, scriptedFactory().factory, config);

    expect(report.cases.map((outcome) => outcome.quarantined)).toEqual([false, true]);
    // Quarantine never changes the verdict, only whether it gates.
    expect(report.cases[1]).toMatchObject({ verdict: 'failed', quarantined: true });
    expect(report.cases[1]!.runs).toHaveLength(2);
  });
  it('stamps the config and the start and finish times on the report', async () => {
    const before = Date.now();
    const report = await runSuite([a], [], scriptedFactory().factory, config);

    expect(report.config).toEqual(config);
    expect(report.startedAt).toBeGreaterThanOrEqual(before);
    expect(report.finishedAt).toBeGreaterThanOrEqual(report.startedAt);
    expect(report.finishedAt).toBeLessThanOrEqual(Date.now());
  });
});
