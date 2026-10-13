// HAND-WRITTEN (block 3): the run loop and the stability rule. The names
// below are the invariants the sketch pins; the bodies land with the
// runner. A fake factory over an in-memory agent is the intended harness:
// no model, no Postgres, the trace and the ledger scripted per test.

import { describe, expect, it } from 'vitest';
import { runOnce } from './runner.js';
import { parseEvalCase } from '../case/schema.js';
import {
  DemoBackend,
  InboxService,
  InMemoryAuditLog,
  InMemoryConversationStore,
  InMemoryRefundLedger,
  Trace,
  type CompletedTrace,
  type TurnOutcome,
} from '@kept-hq/core';
import type { AgentFactory, EvalAgent, RunHandle, RunWorld } from './types.js';
import { materializeFixtures } from './fixtures.js';

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
  it.todo('opens a conversation the first time its ordinal appears and continues it afterwards');
  it.todo('jump_clock advances the clock the factory received and nothing else');
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
  it.todo(
    'a take-over is recorded with the conversation ordinal, the turns it had so far, and the run clock',
  );
  it.todo('the observation is taken once after the last step and every assertion runs against it');
  it.todo('a factory throw is an error of kind boot_failed');
  it.todo(
    'a turn that fails with reason internal is an error of kind turn_internal; max_rounds and refusal are assertable outcomes',
  );
  it.todo('an inbox refusal on an operator step is an error of kind step_refused');
  it.todo('anything else thrown is an error of kind unexpected, and the agent is still shut down');
  it.todo(
    'the outcome carries every assertion, passed ones included, and the trace ids of the run',
  );
});

describe('resolveRefund', () => {
  it.todo('exactly one record matching the selector among the given statuses is returned');
  it.todo('zero matches is a RunFailure of kind selector_unresolved that names the selector');
  it.todo('several matches is a RunFailure of kind selector_unresolved that says how many');
});

describe('buildObservation', () => {
  it.todo('lists the ledger once and copies the transcript; nothing in the observation is a port');
  it.todo('carries the declared policy from the case and the effective policy from the handle');
  it.todo('the clock at the end is the clock after the last step');
});

describe('verdictFor (the stability rule)', () => {
  it.todo('every run passed is passed');
  it.todo('every run failed is failed');
  it.todo('any disagreement between passed and failed is flaky');
  it.todo('any errored run voids the case: the verdict is error whatever the other runs did');
  it.todo('no runs is an error, not a pass');
});

describe('runCase', () => {
  it.todo('runs the case config.runs times, each in a fresh world');
  it.todo('folds the runs with verdictFor and keeps every run outcome');
});

describe('runSuite', () => {
  it.todo('runs every case in order and returns one outcome per case');
  it.todo('a quarantined case runs and is reported with quarantined: true');
  it.todo('stamps the config and the start and finish times on the report');
});
