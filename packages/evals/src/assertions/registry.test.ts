// HAND-WRITTEN (block 3): one describe per assertion kind, the invariant
// each pins. The harness is a hand-built Observation with scripted traces
// (CompletedTrace literals) and ledger records; no runner involved.

import { describe, expect, it } from 'vitest';
import { ASSERTIONS } from './registry.js';
import { FAULT_TOGGLES } from '../case/schema.js';
import {
  DEFAULT_POLICY_CONFIG,
  DEFAULT_RETRIEVAL_CONFIG,
  Trace,
  customerKeyFor,
  makeDemoOrders,
  type CompletedTrace,
  type DecisionRecord,
  type DecisionResult,
  type DenyReason,
  type PolicyEngineConfig,
  type PolicyRequest,
  type RefundLedgerRecord,
  type RequireApprovalReason,
  type RetrievalVerdict,
  type RetrievedChunk,
  type ToolArgs,
  type ToolName,
  type ToolResultState,
  type TurnOutcome,
} from '@kept-hq/core';
import type { AssertionResult, Observation } from '../run/types.js';
import type { AssertionKind, AssertionOf, CaseAssertion } from '../case/schema.js';
import { evaluateAssertion } from './registry.js';

export const NOW = Date.UTC(2026, 8, 10, 12);
const HOUR = 3_600_000;

/** An observation with nothing in it; spread what a test needs over it. */
export function makeObservation(overrides: Partial<Observation> = {}): Observation {
  return {
    ledger: [],
    traces: [],
    timeline: [],
    conversationIds: [],
    takeOvers: [],
    orders: makeDemoOrders(NOW),
    declaredPolicy: DEFAULT_POLICY_CONFIG,
    effectivePolicy: DEFAULT_POLICY_CONFIG,
    clockAtEnd: NOW,
    faultToggles: [],
    ...overrides,
  };
}

/** Arranges traces per conversation and derives timeline and ids; pass conversations in run order. */
export function conversations(
  ...perConversation: CompletedTrace[][]
): Pick<Observation, 'traces' | 'timeline' | 'conversationIds'> {
  return {
    traces: perConversation,
    timeline: perConversation.flat(),
    conversationIds: perConversation.map(
      (traces, index) => traces[0]?.sessionId ?? `conv-${index + 1}`,
    ),
  };
}

type ToolSpec = {
  name: ToolName;
  args?: ToolArgs;
  state?: ToolResultState;
  result?: unknown;
  /** search_policy: the retrieval span under the call. */
  retrieval?: { verdict: RetrievalVerdict; chunks?: RetrievedChunk[] };
  /** issue_refund: the policy_decision span under the call. */
  decision?: {
    request: PolicyRequest;
    outcome: DecisionResult['outcome'];
    reason?: RequireApprovalReason | DenyReason;
  };
};

type TurnSpec = {
  conversationId?: string;
  customer?: string;
  outcome?: TurnOutcome;
  tools?: ToolSpec[];
  /** 0 for the host's take-over deferral, which never asks the model. */
  modelCalls?: number;
};

/** One turn's completed trace: a turn span, N model calls, and the tool calls with their child spans. */
export function turnTrace(spec: TurnSpec = {}): CompletedTrace {
  const conversationId = spec.conversationId ?? 'conv-1';
  const trace = new Trace({
    sessionId: conversationId,
    providerName: 'fake',
    promptName: 'main-agent',
    promptVersion: '1.2.0',
    promptHash: 'hash-fake',
    backendKind: 'demo',
  });
  const turn = trace.startTurnSpan(null, { customerInput: spec.customer ?? 'hi' });
  for (let i = 0; i < (spec.modelCalls ?? 1); i++) {
    trace
      .startModelCallSpan(turn.id, {
        promptName: 'main-agent',
        promptVersion: '1.2.0',
        promptHash: 'hash-fake',
        providerName: 'fake',
        model: 'fake-model',
        inputMessages: [],
      })
      .end({});
  }
  for (const [index, tool] of (spec.tools ?? []).entries()) {
    const call = trace.startToolExecutionSpan(turn.id, {
      callId: `call-${index + 1}`,
      toolName: tool.name,
      args: tool.args ?? {},
    });
    if (tool.retrieval) {
      trace
        .startRetrievalSpan(call.id, {
          query: String(tool.args?.['question'] ?? 'question'),
          scope: { storeId: 'loomhaven', asOf: NOW },
          config: DEFAULT_RETRIEVAL_CONFIG,
        })
        .end({ verdict: tool.retrieval.verdict, chunks: tool.retrieval.chunks ?? [] });
    }
    if (tool.decision) {
      const record: DecisionRecord = {
        configHash: 'cfg-fake',
        request: tool.decision.request,
        eligibility: [],
        perCap: [],
      };
      trace
        .startPolicyDecisionSpan(call.id, {
          configHash: 'cfg-fake',
          request: tool.decision.request,
        })
        .end({
          outcome: tool.decision.outcome,
          decision: record,
          ...(tool.decision.reason === undefined ? {} : { reason: tool.decision.reason }),
        });
    }
    call.end({ resultState: tool.state ?? 'ok', result: tool.result ?? null });
  }
  turn.end({ outcome: spec.outcome ?? { type: 'reply', message: 'ok' } });
  return trace.end();
}

/** A chunk that cleared the threshold, LH-RET §1 unless told otherwise. */
export function chunk(overrides: Partial<RetrievedChunk> = {}): RetrievedChunk {
  return {
    id: 'LH-RET@1.2#§1',
    docId: 'LH-RET',
    docTitle: 'Loomhaven Apparel Co. — Return & Refund Policy',
    sectionRef: '§1',
    tier: 'binding',
    version: '1.2',
    text: 'text',
    effectiveFrom: Date.UTC(2026, 2, 1),
    effectiveTo: null,
    distance: 0.4,
    dropped: false,
    ...overrides,
  };
}

/** The request issue_refund would build for one boot on order-1002. */
export function refundRequest(overrides: Partial<PolicyRequest> = {}): PolicyRequest {
  return {
    action: 'issue_refund',
    customerKey: customerKeyFor({ email: 'sam@example.com' }),
    orderId: 'order-1002',
    orderItemId: 'order-1002-line-1',
    quantity: 1,
    currency: 'USD',
    amountMinorUnits: 8900,
    ...overrides,
  };
}

/** An executed boot refund, an hour before the clock, unless told otherwise. */
export function ledgerRecord(overrides: Partial<RefundLedgerRecord> = {}): RefundLedgerRecord {
  const request = refundRequest();
  return {
    id: 'rec-1',
    idempotencyKey: 'rec-1',
    callId: 'call-1',
    orderId: request.orderId,
    orderItemId: request.orderItemId,
    quantity: request.quantity,
    customerKey: request.customerKey,
    conversationId: 'conv-1',
    promptHash: 'hash-fake',
    amountMinorUnits: request.amountMinorUnits,
    currency: request.currency,
    createdAt: NOW - HOUR,
    decisionRecord: {
      outcome: 'allow',
      record: { configHash: 'cfg-fake', request, eligibility: [], perCap: [] },
    },
    status: 'ok',
    backendRefundId: 'backend-1',
    refundedAmountMinorUnits: request.amountMinorUnits,
    refundedAmountCurrency: request.currency,
    ...overrides,
  };
}

describe('the registry', () => {
  it('has one entry per assertion kind the schema knows, and the toggle vocabulary is the plan’s five', () => {
    expect(Object.keys(ASSERTIONS).toSorted()).toEqual(
      [
        'composed_cap_sum',
        'ledger_records',
        'no_model_call_after_takeover',
        'no_write_before_call',
        'policy_decision',
        'reply_contains',
        'reply_not_contains',
        'retrieval_verdict',
        'retrieved_sections',
        'tool_call_sequence',
        'tool_calls',
        'turn_outcome',
      ].toSorted(),
    );
    expect(FAULT_TOGGLES).toHaveLength(5);
  });
});

describe('tool_call_sequence', () => {
  it('passes when the tools appear in this order as a subsequence of the addressed calls', () => {
    const observation = makeObservation({
      ...conversations([
        turnTrace({
          tools: [
            { name: 'lookup_order', args: { orderId: 'order-1002' } },
            { name: 'issue_refund', args: { orderId: 'order-1002' } },
          ],
        }),
      ]),
    });

    const verdict = ASSERTIONS.tool_call_sequence(observation, {
      id: 'test',
      kind: 'tool_call_sequence',
      expectRedUnder: [],
      tools: ['lookup_order', 'issue_refund'],
      at: {
        conversation: 1,
        turn: 1,
      },
    });

    expect(verdict.passed).toEqual(true);
  });
  it('fails, naming the first tool out of order, when they do not', () => {
    const observation = makeObservation({
      ...conversations([
        turnTrace({
          tools: [
            { name: 'lookup_order', args: { orderId: 'order-1002' } },
            { name: 'issue_refund', args: { orderId: 'order-1002' } },
            { name: 'search_policy', args: { question: 'returns?' } },
          ],
        }),
      ]),
    });

    const verdict = ASSERTIONS.tool_call_sequence(observation, {
      id: 'test',
      kind: 'tool_call_sequence',
      expectRedUnder: [],
      tools: ['search_policy', 'lookup_order', 'issue_refund'],
      at: {
        conversation: 1,
      },
    });

    expect(verdict.passed).toEqual(false);
    if (verdict.passed) throw new Error('expected a failure');
    expect(verdict.reason).toMatch(/lookup_order/);
  });
  it('without `at` reads conversation 1, every turn in order', () => {
    const observation = makeObservation({
      ...conversations([
        turnTrace({
          tools: [
            { name: 'lookup_order', args: { orderId: 'order-1002' } },
            { name: 'issue_refund', args: { orderId: 'order-1002' } },
          ],
        }),
        turnTrace({
          tools: [
            { name: 'issue_refund', args: { orderId: 'order-1002' } },
            { name: 'lookup_order', args: { orderId: 'order-1002' } },
          ],
        }),
      ]),
    });

    const verdict = ASSERTIONS.tool_call_sequence(observation, {
      id: 'test',
      kind: 'tool_call_sequence',
      expectRedUnder: [],
      tools: ['lookup_order', 'issue_refund'],
    });

    expect(verdict.passed).toEqual(true);
  });

  it('a lookup_order in conversation 2 should not satisfy an issue_refund in conversation 1', () => {
    const observation = makeObservation({
      ...conversations([
        turnTrace({
          tools: [{ name: 'issue_refund', args: { orderId: 'order-1002' } }],
        }),
        turnTrace({
          tools: [{ name: 'lookup_order', args: { orderId: 'order-1002' } }],
        }),
      ]),
    });

    const verdict = ASSERTIONS.tool_call_sequence(observation, {
      id: 'test',
      kind: 'tool_call_sequence',
      expectRedUnder: [],
      tools: ['lookup_order', 'issue_refund'],
      at: {
        conversation: 1,
      },
    });

    expect(verdict.passed).toEqual(false);
  });
});

// --- Shared by the kinds below -------------------------------------------------------

/** Evaluates one assertion against an observation; the id and the toggle list are noise here. */
function check<K extends AssertionKind>(
  observation: Observation,
  assertion: Omit<AssertionOf<K>, 'id' | 'expectRedUnder'> & { kind: K },
): AssertionResult {
  // The spread of a generic Omit is opaque to TypeScript's overlap check; the
  // schema is what guarantees the shape, so the cast goes through unknown.
  const full: unknown = { id: 'test', expectRedUnder: [], ...assertion };
  return evaluateAssertion(observation, full as CaseAssertion);
}

function reasonOf(result: AssertionResult): string {
  if (result.passed) throw new Error('expected a failure');
  return result.reason;
}

function traceIdOf(result: AssertionResult): string | undefined {
  if (result.passed) throw new Error('expected a failure');
  return result.traceId;
}

/** A record the backend has not executed: no refund id, no moved amount. */
function openRecord(overrides: Partial<RefundLedgerRecord> = {}): RefundLedgerRecord {
  const record = ledgerRecord({ status: 'pending', ...overrides });
  delete record.backendRefundId;
  delete record.refundedAmountMinorUnits;
  delete record.refundedAmountCurrency;
  return record;
}

const DAY = 24 * HOUR;

describe('tool_calls', () => {
  const observation = makeObservation({
    ...conversations([
      turnTrace({
        tools: [
          { name: 'lookup_order', args: { orderId: 'order-1005' } },
          { name: 'issue_refund', args: { orderId: 'order-1005', quantity: 1 }, state: 'unknown' },
        ],
      }),
      turnTrace({
        tools: [
          { name: 'issue_refund', args: { orderId: 'order-1005', quantity: 1 }, state: 'failed' },
        ],
      }),
    ]),
  });

  it('counts tool_execution spans matching tool, state and an args subset', () => {
    expect(check(observation, { kind: 'tool_calls', where: {}, count: { eq: 3 } }).passed).toBe(
      true,
    );
    expect(
      check(observation, { kind: 'tool_calls', where: { tool: 'issue_refund' }, count: { eq: 2 } })
        .passed,
    ).toBe(true);
    expect(
      check(observation, {
        kind: 'tool_calls',
        where: { tool: 'issue_refund', state: 'unknown' },
        count: { eq: 1 },
      }).passed,
    ).toBe(true);
    expect(
      check(observation, {
        kind: 'tool_calls',
        where: { tool: 'issue_refund', args: { orderId: 'order-1005' } },
        count: { eq: 2 },
      }).passed,
    ).toBe(true);
    // `at` narrows to one turn.
    expect(
      check(observation, {
        kind: 'tool_calls',
        where: { tool: 'issue_refund' },
        count: { eq: 1 },
        at: { conversation: 1, turn: 2 },
      }).passed,
    ).toBe(true);
  });
  it('an args subset matches when every named argument is deeply equal', () => {
    const nested = makeObservation({
      ...conversations([
        turnTrace({
          tools: [
            { name: 'issue_refund', args: { orderId: 'order-1005', line: { id: 'l-1', qty: 2 } } },
          ],
        }),
      ]),
    });
    expect(
      check(nested, {
        kind: 'tool_calls',
        where: { args: { line: { id: 'l-1', qty: 2 } } },
        count: { eq: 1 },
      }).passed,
    ).toBe(true);
    // A nested object must match whole: a partial inner object is not a subset match.
    expect(
      check(nested, {
        kind: 'tool_calls',
        where: { args: { line: { id: 'l-1' } } },
        count: { eq: 1 },
      }).passed,
    ).toBe(false);
    // An argument the call does not carry never matches.
    expect(
      check(nested, {
        kind: 'tool_calls',
        where: { args: { reason: 'damaged' } },
        count: { eq: 0 },
      }).passed,
    ).toBe(true);
  });
  it('the count bounds eq, gte and lte are all checked', () => {
    const where = { tool: 'issue_refund' as const };
    expect(check(observation, { kind: 'tool_calls', where, count: { gte: 2 } }).passed).toBe(true);
    expect(check(observation, { kind: 'tool_calls', where, count: { lte: 1 } }).passed).toBe(false);
    expect(
      check(observation, { kind: 'tool_calls', where, count: { gte: 1, lte: 2 } }).passed,
    ).toBe(true);
    const red = check(observation, { kind: 'tool_calls', where, count: { eq: 1 } });
    expect(reasonOf(red)).toMatch(/2/);
    expect(traceIdOf(red)).toBeDefined();
  });
});

describe('no_write_before_call', () => {
  const lookupThenRefund = turnTrace({
    tools: [
      { name: 'lookup_order', args: { orderId: 'order-1002' } },
      { name: 'issue_refund', args: { orderId: 'order-1002', orderItemId: 'order-1002-line-1' } },
    ],
  });

  it('passes when every write call has an earlier call of mustFollow', () => {
    const observation = makeObservation({ ...conversations([lookupThenRefund]) });
    expect(
      check(observation, {
        kind: 'no_write_before_call',
        write: 'issue_refund',
        mustFollow: 'lookup_order',
      }).passed,
    ).toBe(true);
    // Across turns of one conversation the lookup still counts.
    const acrossTurns = makeObservation({
      ...conversations([
        turnTrace({ tools: [{ name: 'lookup_order', args: { orderId: 'order-1002' } }] }),
        turnTrace({ tools: [{ name: 'issue_refund', args: { orderId: 'order-1002' } }] }),
      ]),
    });
    expect(
      check(acrossTurns, {
        kind: 'no_write_before_call',
        write: 'issue_refund',
        mustFollow: 'lookup_order',
        sharedArg: 'orderId',
      }).passed,
    ).toBe(true);
    // Across conversations it does not: a lookup in chat 2 never justifies a write in chat 1.
    const acrossConversations = makeObservation({
      ...conversations(
        [turnTrace({ tools: [{ name: 'issue_refund', args: { orderId: 'order-1002' } }] })],
        [
          turnTrace({
            conversationId: 'conv-2',
            tools: [{ name: 'lookup_order', args: { orderId: 'order-1002' } }],
          }),
        ],
      ),
    });
    expect(
      check(acrossConversations, {
        kind: 'no_write_before_call',
        write: 'issue_refund',
        mustFollow: 'lookup_order',
      }).passed,
    ).toBe(false);
  });
  it('with sharedArg, the earlier call must carry the same value for that argument', () => {
    const otherOrder = makeObservation({
      ...conversations([
        turnTrace({
          tools: [
            { name: 'lookup_order', args: { orderId: 'order-1005' } },
            { name: 'issue_refund', args: { orderId: 'order-1002' } },
          ],
        }),
      ]),
    });
    expect(
      check(otherOrder, {
        kind: 'no_write_before_call',
        write: 'issue_refund',
        mustFollow: 'lookup_order',
      }).passed,
    ).toBe(true);
    expect(
      check(otherOrder, {
        kind: 'no_write_before_call',
        write: 'issue_refund',
        mustFollow: 'lookup_order',
        sharedArg: 'orderId',
      }).passed,
    ).toBe(false);
    // A write that does not carry the shared argument at all is never justified.
    const noArg = makeObservation({
      ...conversations([
        turnTrace({
          tools: [
            { name: 'lookup_order', args: {} },
            { name: 'issue_refund', args: {} },
          ],
        }),
      ]),
    });
    expect(
      check(noArg, {
        kind: 'no_write_before_call',
        write: 'issue_refund',
        mustFollow: 'lookup_order',
        sharedArg: 'orderId',
      }).passed,
    ).toBe(false);
  });
  it('fails naming the write call that had no preceding call', () => {
    const refundFirst = turnTrace({
      tools: [
        { name: 'issue_refund', args: { orderId: 'order-1002' } },
        { name: 'lookup_order', args: { orderId: 'order-1002' } },
      ],
    });
    const observation = makeObservation({ ...conversations([refundFirst]) });
    const red = check(observation, {
      kind: 'no_write_before_call',
      write: 'issue_refund',
      mustFollow: 'lookup_order',
      sharedArg: 'orderId',
    });
    expect(reasonOf(red)).toMatch(/issue_refund requires lookup_order/);
    expect(reasonOf(red)).toMatch(/orderId/);
    expect(traceIdOf(red)).toBe(refundFirst.id);
  });
});

describe('ledger_records', () => {
  const observation = makeObservation({
    ledger: [
      ledgerRecord({ id: 'r-1' }),
      openRecord({ id: 'r-2', orderItemId: 'order-1002-line-2', amountMinorUnits: 1200 }),
      ledgerRecord({
        id: 'r-3',
        orderId: 'order-1005',
        orderItemId: 'order-1005-line-1',
        quantity: 2,
      }),
      openRecord({ id: 'r-4', status: 'denied' }),
    ],
  });

  it('counts records matching orderId, orderItemId, quantity and any of the statuses', () => {
    expect(
      check(observation, {
        kind: 'ledger_records',
        where: { orderId: 'order-1002' },
        count: { eq: 3 },
      }).passed,
    ).toBe(true);
    expect(
      check(observation, {
        kind: 'ledger_records',
        where: { orderId: 'order-1002', orderItemId: 'order-1002-line-1' },
        count: { eq: 2 },
      }).passed,
    ).toBe(true);
    expect(
      check(observation, {
        kind: 'ledger_records',
        where: { orderId: 'order-1002', status: ['pending', 'denied'] },
        count: { eq: 2 },
      }).passed,
    ).toBe(true);
    expect(
      check(observation, { kind: 'ledger_records', where: { quantity: 2 }, count: { eq: 1 } })
        .passed,
    ).toBe(true);
    const red = check(observation, {
      kind: 'ledger_records',
      where: { status: ['ok'] },
      count: { eq: 0 },
    });
    expect(reasonOf(red)).toMatch(/received: 2/);
  });
  it('an empty where counts every record', () => {
    expect(check(observation, { kind: 'ledger_records', where: {}, count: { eq: 4 } }).passed).toBe(
      true,
    );
    expect(
      check(makeObservation(), { kind: 'ledger_records', where: {}, count: { eq: 0 } }).passed,
    ).toBe(true);
  });
});

describe('policy_decision', () => {
  const observation = makeObservation({
    ...conversations([
      turnTrace({
        tools: [
          {
            name: 'issue_refund',
            args: { orderId: 'order-1002', orderItemId: 'order-1002-line-1', quantity: 1 },
            decision: { request: refundRequest(), outcome: 'allow' },
          },
        ],
      }),
      turnTrace({
        tools: [
          {
            name: 'issue_refund',
            args: { orderId: 'order-1002', orderItemId: 'order-1002-line-1', quantity: 1 },
            decision: { request: refundRequest(), outcome: 'deny', reason: 'already_requested' },
          },
          {
            name: 'issue_refund',
            args: { orderId: 'order-1002', orderItemId: 'order-1002-line-2', quantity: 1 },
            decision: {
              request: refundRequest({ orderItemId: 'order-1002-line-2', amountMinorUnits: 1200 }),
              outcome: 'require_approval',
              reason: 'cap_exceeded',
            },
          },
        ],
      }),
    ]),
  });
  const boot = { orderId: 'order-1002', orderItemId: 'order-1002-line-1' };

  it('finds the policy_decision span whose request matches the selector, first or last', () => {
    expect(
      check(observation, {
        kind: 'policy_decision',
        refund: boot,
        occurrence: 'first',
        expected: { outcome: 'allow' },
      }).passed,
    ).toBe(true);
    expect(
      check(observation, {
        kind: 'policy_decision',
        refund: boot,
        occurrence: 'last',
        expected: { outcome: 'deny', reason: 'already_requested' },
      }).passed,
    ).toBe(true);
    // A line-less selector matches every decision on the order; last is the insoles.
    expect(
      check(observation, {
        kind: 'policy_decision',
        refund: { orderId: 'order-1002' },
        occurrence: 'last',
        expected: { outcome: 'require_approval', reason: 'cap_exceeded' },
      }).passed,
    ).toBe(true);
  });
  it('checks the outcome, and the reason only when one is expected', () => {
    expect(
      check(observation, {
        kind: 'policy_decision',
        refund: boot,
        occurrence: 'last',
        expected: { outcome: 'deny' },
      }).passed,
    ).toBe(true);
    const wrongReason = check(observation, {
      kind: 'policy_decision',
      refund: boot,
      occurrence: 'last',
      expected: { outcome: 'deny', reason: 'not_eligible' },
    });
    expect(reasonOf(wrongReason)).toMatch(/already_requested/);
    const wrongOutcome = check(observation, {
      kind: 'policy_decision',
      refund: boot,
      occurrence: 'first',
      expected: { outcome: 'deny' },
    });
    expect(reasonOf(wrongOutcome)).toMatch(/allow/);
    expect(traceIdOf(wrongOutcome)).toBe(observation.timeline[0]!.id);
  });
  it('fails when no decision was made for the selector', () => {
    const red = check(observation, {
      kind: 'policy_decision',
      refund: { orderId: 'order-1004' },
      occurrence: 'last',
      expected: { outcome: 'allow' },
    });
    expect(reasonOf(red)).toMatch(/No matching policy decision/);
  });
});

describe('composed_cap_sum', () => {
  // Default caps: 100 per call, 100 per order, 150 per customer over 30 days,
  // 300 per day, in USD and in EUR. sam owns order-1002 and order-1005.
  const boot = ledgerRecord({ id: 'boot' }); // 8900, order-1002, sam
  const insoles = openRecord({
    id: 'insoles',
    orderItemId: 'order-1002-line-2',
    amountMinorUnits: 1200,
  });
  const baseLayer = ledgerRecord({
    id: 'base-layer',
    orderId: 'order-1005',
    orderItemId: 'order-1005-line-1',
    amountMinorUnits: 7900,
    refundedAmountMinorUnits: 7900,
  });
  const anaJacket = ledgerRecord({
    id: 'jacket',
    orderId: 'order-1004',
    orderItemId: 'order-1004-line-1',
    customerKey: customerKeyFor({ email: 'ana@example.com' }),
    amountMinorUnits: 15900,
    currency: 'EUR',
    refundedAmountMinorUnits: 15900,
    refundedAmountCurrency: 'EUR',
  });
  const perOrder = {
    kind: 'composed_cap_sum' as const,
    cap: 'per_order' as const,
    currency: 'USD' as const,
    orderId: 'order-1002',
  };

  it('sums what the engine let out on its own: attempted, ok or unknown with an allow decision, in one currency', () => {
    // 8900 executed + 1200 executed = 10100 over the 10000 per-order cap.
    const insolesExecuted = ledgerRecord({
      id: 'insoles',
      orderItemId: 'order-1002-line-2',
      amountMinorUnits: 1200,
      refundedAmountMinorUnits: 1200,
    });
    const over = check(makeObservation({ ledger: [boot, insolesExecuted] }), perOrder);
    expect(reasonOf(over)).toMatch(/per_order sum 10100 over the declared cap 10000 USD/);
    expect(reasonOf(over)).toMatch(/records the engine allowed: boot ok 8900, insoles ok 1200/);
    // A pending record is the engine routing an over-cap request to a human:
    // the ledger reserves it for the next decision, the invariant does not count it.
    expect(check(makeObservation({ ledger: [boot, insoles] }), perOrder).passed).toBe(true);
    // A denied record never counts, nor a failed one.
    const denied = openRecord({
      id: 'insoles',
      orderItemId: 'order-1002-line-2',
      amountMinorUnits: 1200,
      status: 'denied',
    });
    expect(check(makeObservation({ ledger: [boot, denied] }), perOrder).passed).toBe(true);
    // A record a human approved was require_approval at decision time: excluded after it executes.
    const approvedByHuman = ledgerRecord({
      ...insolesExecuted,
      decisionRecord: {
        outcome: 'require_approval',
        reason: 'cap_exceeded',
        record: { configHash: 'cfg-fake', request: refundRequest(), eligibility: [], perCap: [] },
      },
    });
    expect(check(makeObservation({ ledger: [boot, approvedByHuman] }), perOrder).passed).toBe(true);
    // Attempted and unknown count like ok: the money may have moved.
    const unknown = ledgerRecord({ ...insolesExecuted, status: 'unknown' });
    expect(check(makeObservation({ ledger: [boot, unknown] }), perOrder).passed).toBe(false);
    // Another currency on the same order is another cap.
    const eurOnSameOrder = ledgerRecord({
      id: 'eur',
      amountMinorUnits: 9000,
      currency: 'EUR',
      refundedAmountCurrency: 'EUR',
    });
    expect(check(makeObservation({ ledger: [boot, eurOnSameOrder] }), perOrder).passed).toBe(true);
    // What the backend moved is what counts, once known.
    const movedLess = ledgerRecord({ id: 'boot', refundedAmountMinorUnits: 8800 });
    expect(check(makeObservation({ ledger: [movedLess, insolesExecuted] }), perOrder).passed).toBe(
      true,
    );
  });
  it('per_call checks each record alone; per_order by orderId; per_customer by the key of the email; per_day everything', () => {
    const ledger = [boot, baseLayer, anaJacket];
    // per_call: 8900 and 7900 are each under 10000, whatever they sum to.
    expect(
      check(makeObservation({ ledger }), {
        kind: 'composed_cap_sum',
        cap: 'per_call',
        currency: 'USD',
      }).passed,
    ).toBe(true);
    const big = ledgerRecord({
      id: 'big',
      amountMinorUnits: 12000,
      refundedAmountMinorUnits: 12000,
    });
    const perCallRed = check(makeObservation({ ledger: [boot, big] }), {
      kind: 'composed_cap_sum',
      cap: 'per_call',
      currency: 'USD',
    });
    expect(reasonOf(perCallRed)).toMatch(/1 record\(s\) over the per_call cap of 10000 USD: big/);
    // per_order: order-1005's record is not order-1002's.
    expect(check(makeObservation({ ledger }), perOrder).passed).toBe(true);
    // per_customer: sam's two orders sum to 16800 over 15000; ana has nothing in USD.
    const sam = check(makeObservation({ ledger }), {
      kind: 'composed_cap_sum',
      cap: 'per_customer',
      currency: 'USD',
      email: 'sam@example.com',
    });
    expect(reasonOf(sam)).toMatch(/per_customer sum 16800/);
    expect(
      check(makeObservation({ ledger }), {
        kind: 'composed_cap_sum',
        cap: 'per_customer',
        currency: 'USD',
        email: 'ana@example.com',
      }).passed,
    ).toBe(true);
    // per_day: every USD record; 16800 is under 30000, a third one is not.
    expect(
      check(makeObservation({ ledger }), {
        kind: 'composed_cap_sum',
        cap: 'per_day',
        currency: 'USD',
      }).passed,
    ).toBe(true);
    const third = ledgerRecord({
      id: 'third',
      orderId: 'order-1001',
      amountMinorUnits: 15000,
      refundedAmountMinorUnits: 15000,
    });
    expect(
      check(makeObservation({ ledger: [...ledger, third] }), {
        kind: 'composed_cap_sum',
        cap: 'per_day',
        currency: 'USD',
      }).passed,
    ).toBe(false);
  });
  it('windowed kinds count from clockAtEnd minus the declared window', () => {
    const perCustomer = {
      kind: 'composed_cap_sum' as const,
      cap: 'per_customer' as const,
      currency: 'USD' as const,
      email: 'sam@example.com',
    };
    // Thirty-one days back is outside the 30-day window.
    const old = ledgerRecord({ ...baseLayer, createdAt: NOW - 31 * DAY });
    expect(
      check(makeObservation({ ledger: [boot, old], clockAtEnd: NOW }), perCustomer).passed,
    ).toBe(true);
    // Exactly at the floor is inside, like LedgerQuery.sinceMs.
    const atFloor = ledgerRecord({ ...baseLayer, createdAt: NOW - 30 * DAY });
    expect(
      check(makeObservation({ ledger: [boot, atFloor], clockAtEnd: NOW }), perCustomer).passed,
    ).toBe(false);
    // The window ends at the run's clock, not at the wall clock.
    expect(
      check(makeObservation({ ledger: [boot, old], clockAtEnd: NOW - 2 * DAY }), perCustomer)
        .passed,
    ).toBe(false);
  });
  it('compares against the DECLARED cap, so a toggle that filters the engine’s config still turns this red', () => {
    const perCallOnly: PolicyEngineConfig = {
      version: 'toggled',
      caps: DEFAULT_POLICY_CONFIG.caps.filter((cap) => cap.kind === 'per_call'),
    };
    // Under the toggle both refunds are allowed and executed: 10100 on the order.
    const observation = makeObservation({
      ledger: [
        boot,
        ledgerRecord({
          id: 'insoles',
          orderItemId: 'order-1002-line-2',
          amountMinorUnits: 1200,
          refundedAmountMinorUnits: 1200,
        }),
      ],
      declaredPolicy: DEFAULT_POLICY_CONFIG,
      effectivePolicy: perCallOnly,
      faultToggles: ['caps-per-call-only'],
    });
    expect(check(observation, perOrder).passed).toBe(false);
  });
  it('a declared cap missing for the kind and currency is a failure that says so', () => {
    const usdOnly: PolicyEngineConfig = {
      version: 'usd',
      caps: DEFAULT_POLICY_CONFIG.caps.filter((cap) => cap.currency === 'USD'),
    };
    const red = check(makeObservation({ ledger: [anaJacket], declaredPolicy: usdOnly }), {
      kind: 'composed_cap_sum',
      cap: 'per_order',
      currency: 'EUR',
      orderId: 'order-1004',
    });
    expect(reasonOf(red)).toMatch(/no declared per_order cap in EUR/);
  });
});

describe('retrieval_verdict', () => {
  const twoSearches = turnTrace({
    tools: [
      {
        name: 'search_policy',
        args: { question: 'mobile number?' },
        retrieval: { verdict: 'no_match' },
      },
      {
        name: 'search_policy',
        args: { question: 'phone number?' },
        retrieval: { verdict: 'grounded', chunks: [chunk()] },
      },
    ],
  });

  it('reads the first, last or every retrieval span of the addressed turn(s)', () => {
    const observation = makeObservation({ ...conversations([twoSearches]) });
    expect(
      check(observation, { kind: 'retrieval_verdict', verdict: 'no_match', occurrence: 'first' })
        .passed,
    ).toBe(true);
    expect(
      check(observation, { kind: 'retrieval_verdict', verdict: 'grounded', occurrence: 'last' })
        .passed,
    ).toBe(true);
    const mixed = check(observation, {
      kind: 'retrieval_verdict',
      verdict: 'no_match',
      occurrence: 'every',
    });
    expect(reasonOf(mixed)).toMatch(/Unexpected retrieval verdicts/);
    const wrongLast = check(observation, {
      kind: 'retrieval_verdict',
      verdict: 'no_match',
      occurrence: 'last',
    });
    expect(reasonOf(wrongLast)).toMatch(/Expected: no_match, got: grounded/);
    expect(traceIdOf(wrongLast)).toBe(twoSearches.id);
    // `every` over two turns that both came back empty.
    const empty = makeObservation({
      ...conversations([
        turnTrace({ tools: [{ name: 'search_policy', retrieval: { verdict: 'no_match' } }] }),
        turnTrace({ tools: [{ name: 'search_policy', retrieval: { verdict: 'no_match' } }] }),
      ]),
    });
    expect(
      check(empty, { kind: 'retrieval_verdict', verdict: 'no_match', occurrence: 'every' }).passed,
    ).toBe(true);
  });
  it('fails when the addressed turn(s) have no retrieval span', () => {
    const noSearch = makeObservation({
      ...conversations([
        turnTrace({ tools: [{ name: 'lookup_order', args: { orderId: 'order-1001' } }] }),
      ]),
    });
    const red = check(noSearch, {
      kind: 'retrieval_verdict',
      verdict: 'grounded',
      occurrence: 'last',
    });
    expect(reasonOf(red)).toMatch(/No search_policy spans/);
  });
});

describe('retrieved_sections', () => {
  const observation = makeObservation({
    ...conversations([
      turnTrace({
        tools: [
          {
            name: 'search_policy',
            retrieval: {
              verdict: 'grounded',
              chunks: [
                chunk({ id: 'LH-RET@1.2#§6', sectionRef: '§6' }),
                chunk({
                  id: 'HC-LH-05',
                  docId: 'HC-LH-05',
                  sectionRef: 'HC-LH-05',
                  tier: 'informational',
                  effectiveFrom: null,
                }),
                chunk({
                  id: 'LH-HOL-2025@1.0#§1',
                  docId: 'LH-HOL-2025',
                  sectionRef: '§1',
                  distance: 0.7,
                  dropped: true,
                }),
              ],
            },
          },
        ],
      }),
    ]),
  });

  it('counts chunks that cleared the threshold, never dropped ones, matching docId, sectionRef and tier', () => {
    expect(
      check(observation, { kind: 'retrieved_sections', where: {}, count: { eq: 2 } }).passed,
    ).toBe(true);
    expect(
      check(observation, {
        kind: 'retrieved_sections',
        where: { docId: 'LH-RET', sectionRef: '§6', tier: 'binding' },
        count: { gte: 1 },
      }).passed,
    ).toBe(true);
    expect(
      check(observation, {
        kind: 'retrieved_sections',
        where: { tier: 'informational' },
        count: { eq: 1 },
      }).passed,
    ).toBe(true);
    // The dropped holiday chunk was ranked and cut: it was not retrieved.
    expect(
      check(observation, {
        kind: 'retrieved_sections',
        where: { docId: 'LH-HOL-2025' },
        count: { eq: 0 },
      }).passed,
    ).toBe(true);
    const red = check(observation, {
      kind: 'retrieved_sections',
      where: { docId: 'LH-RET' },
      count: { eq: 0 },
    });
    expect(reasonOf(red)).toMatch(/received: 1/);
    expect(traceIdOf(red)).toBe(observation.timeline[0]!.id);
    // No retrieval at all is a failure, not a count of zero.
    const noSearch = makeObservation({ ...conversations([turnTrace()]) });
    expect(
      reasonOf(check(noSearch, { kind: 'retrieved_sections', where: {}, count: { eq: 0 } })),
    ).toMatch(/No search_policy spans/);
  });
});

describe('reply_contains / reply_not_contains', () => {
  const first = turnTrace({ outcome: { type: 'reply', message: 'The fee is $6.50 per return.' } });
  const second = turnTrace({
    conversationId: 'conv-2',
    outcome: { type: 'reply', message: 'Please contact support@test.com.' },
  });
  const observation = makeObservation({ ...conversations([first], [second]) });

  it('reads the reply of the addressed turn, the last turn of the run by default', () => {
    expect(
      check(observation, { kind: 'reply_contains', strings: ['support@test.com'], mode: 'all' })
        .passed,
    ).toBe(true);
    expect(
      check(observation, { kind: 'reply_contains', strings: ['6.50'], mode: 'all' }).passed,
    ).toBe(false);
    expect(
      check(observation, {
        kind: 'reply_contains',
        strings: ['6.50'],
        mode: 'all',
        at: { conversation: 1 },
      }).passed,
    ).toBe(true);
    expect(
      check(observation, {
        kind: 'reply_not_contains',
        strings: ['6.50'],
        at: { conversation: 2, turn: 1 },
      }).passed,
    ).toBe(true);
  });
  it('matches case-insensitively; mode all needs every string, mode any needs one', () => {
    const single = makeObservation({ ...conversations([first]) });
    expect(
      check(single, { kind: 'reply_contains', strings: ['THE FEE', 'per RETURN'], mode: 'all' })
        .passed,
    ).toBe(true);
    const missingOne = check(single, {
      kind: 'reply_contains',
      strings: ['the fee', 'free'],
      mode: 'all',
    });
    expect(reasonOf(missingOne)).toMatch(/free/);
    expect(traceIdOf(missingOne)).toBe(first.id);
    expect(
      check(single, { kind: 'reply_contains', strings: ['free', 'the fee'], mode: 'any' }).passed,
    ).toBe(true);
    expect(
      check(single, { kind: 'reply_contains', strings: ['free', 'gratis'], mode: 'any' }).passed,
    ).toBe(false);
    const contained = check(single, { kind: 'reply_not_contains', strings: ['FEE', 'gratis'] });
    expect(reasonOf(contained)).toMatch(/FEE/);
    expect(check(single, { kind: 'reply_not_contains', strings: ['gratis'] }).passed).toBe(true);
  });
  it('a turn without a reply fails both kinds, naming the outcome', () => {
    const failed = makeObservation({
      ...conversations([turnTrace({ outcome: { type: 'failed', reason: 'max_rounds' } })]),
    });
    expect(
      reasonOf(check(failed, { kind: 'reply_contains', strings: ['x'], mode: 'all' })),
    ).toMatch(/not a reply: failed/);
    expect(reasonOf(check(failed, { kind: 'reply_not_contains', strings: ['x'] }))).toMatch(
      /not a reply: failed/,
    );
  });
});

describe('turn_outcome', () => {
  it('checks the type, and the failure reason only when one is expected', () => {
    const reply = makeObservation({ ...conversations([turnTrace()]) });
    expect(check(reply, { kind: 'turn_outcome', expected: { type: 'reply' } }).passed).toBe(true);
    expect(reasonOf(check(reply, { kind: 'turn_outcome', expected: { type: 'failed' } }))).toMatch(
      /Expected: failed, got: reply/,
    );

    const refused = makeObservation({
      ...conversations([turnTrace({ outcome: { type: 'failed', reason: 'refusal' } })]),
    });
    expect(check(refused, { kind: 'turn_outcome', expected: { type: 'failed' } }).passed).toBe(
      true,
    );
    expect(
      check(refused, { kind: 'turn_outcome', expected: { type: 'failed', reason: 'refusal' } })
        .passed,
    ).toBe(true);
    expect(
      reasonOf(
        check(refused, {
          kind: 'turn_outcome',
          expected: { type: 'failed', reason: 'max_rounds' },
        }),
      ),
    ).toMatch(/expected reason: max_rounds; got: refusal/);

    // The last turn of the addressed conversation is the one checked.
    const full = makeObservation({
      ...conversations([turnTrace(), turnTrace({ outcome: { type: 'conversation_full' } })]),
    });
    expect(
      check(full, { kind: 'turn_outcome', expected: { type: 'conversation_full' } }).passed,
    ).toBe(true);
    expect(
      check(full, {
        kind: 'turn_outcome',
        expected: { type: 'reply' },
        at: { conversation: 1, turn: 1 },
      }).passed,
    ).toBe(true);
  });
});

describe('no_model_call_after_takeover', () => {
  const HANDOFF = {
    type: 'reply' as const,
    message: 'A member of our support team has taken over.',
  };

  it('passes when no trace of the conversation started after its take-over holds a model_call span', () => {
    const observation = makeObservation({
      ...conversations([turnTrace(), turnTrace({ modelCalls: 0, outcome: HANDOFF })]),
      takeOvers: [{ conversation: 1, afterTurn: 1, at: NOW }],
    });
    expect(
      check(observation, { kind: 'no_model_call_after_takeover', conversation: 1 }).passed,
    ).toBe(true);

    // The turn before the take-over may have asked the model; the one after may not.
    const offending = turnTrace({ outcome: HANDOFF });
    const red = check(
      makeObservation({
        ...conversations([turnTrace(), offending]),
        takeOvers: [{ conversation: 1, afterTurn: 1, at: NOW }],
      }),
      { kind: 'no_model_call_after_takeover', conversation: 1 },
    );
    expect(reasonOf(red)).toMatch(/model call after/);
    expect(traceIdOf(red)).toBe(offending.id);

    // Only the taken-over conversation is checked.
    const other = makeObservation({
      ...conversations(
        [turnTrace(), turnTrace()],
        [turnTrace({ conversationId: 'conv-2', modelCalls: 0 })],
      ),
      takeOvers: [{ conversation: 2, afterTurn: 0, at: NOW }],
    });
    expect(check(other, { kind: 'no_model_call_after_takeover', conversation: 2 }).passed).toBe(
      true,
    );
  });
  it('fails when the conversation was never taken over', () => {
    const observation = makeObservation({ ...conversations([turnTrace({ modelCalls: 0 })]) });
    expect(
      reasonOf(check(observation, { kind: 'no_model_call_after_takeover', conversation: 1 })),
    ).toMatch(/never taken over/);
  });
});
