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
import type { Observation } from '../run/types.js';

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

describe('tool_calls', () => {
  it.todo('counts tool_execution spans matching tool, state and an args subset');
  it.todo('an args subset matches when every named argument is deeply equal');
  it.todo('the count bounds eq, gte and lte are all checked');
});

describe('no_write_before_call', () => {
  it.todo('passes when every write call has an earlier call of mustFollow');
  it.todo('with sharedArg, the earlier call must carry the same value for that argument');
  it.todo('fails naming the write call id that had no preceding call');
});

describe('ledger_records', () => {
  it.todo('counts records matching orderId, orderItemId, quantity and any of the statuses');
  it.todo('an empty where counts every record');
});

describe('policy_decision', () => {
  it.todo('finds the policy_decision span whose request matches the selector, first or last');
  it.todo('checks the outcome, and the reason only when one is expected');
  it.todo('fails when no decision was made for the selector');
});

describe('composed_cap_sum', () => {
  it.todo(
    'sums counting records (COUNTING_STATUSES) in the cap’s scope and one currency, like the ledger does',
  );
  it.todo(
    'per_call checks each record alone; per_order by orderId; per_customer by the key of the email; per_day everything',
  );
  it.todo('windowed kinds count from clockAtEnd minus the declared window');
  it.todo(
    'compares against the DECLARED cap, so a toggle that filters the engine’s config still turns this red',
  );
  it.todo('a declared cap missing for the kind and currency is a failure that says so');
});

describe('retrieval_verdict', () => {
  it.todo('reads the first, last or every retrieval span of the addressed turn(s)');
  it.todo('fails when the addressed turn(s) have no retrieval span');
});

describe('retrieved_sections', () => {
  it.todo(
    'counts chunks that cleared the threshold, never dropped ones, matching docId, sectionRef and tier',
  );
});

describe('reply_contains / reply_not_contains', () => {
  it.todo('reads the reply of the addressed turn, the last turn of the run by default');
  it.todo('matches case-insensitively; mode all needs every string, mode any needs one');
  it.todo('a turn without a reply fails reply_contains and passes reply_not_contains');
});

describe('turn_outcome', () => {
  it.todo('checks the type, and the failure reason only when one is expected');
});

describe('no_model_call_after_takeover', () => {
  it.todo(
    'passes when no trace of the conversation started after its take-over holds a model_call span',
  );
  it.todo('fails when the conversation was never taken over');
});
