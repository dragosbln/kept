// Unit tests for the tool registry's execute functions, run against a fake
// OrderBackend. The load-bearing assertions are the sanitization boundary:
// nothing past sanitizeOrderForModel may carry the customer email — it is
// the identity-check credential, so the model must never read it off the
// order, in neither the model-facing response nor the trace-facing result.

import { describe, expect, it } from 'vitest';
import { createToolRegistry } from './registry.js';
import type { ToolExecuteContext } from './types.js';
import type { Order } from '../backend/types.js';
import type { OrderBackend } from '../backend/order-backend.js';
import { makeDemoOrders } from '../backend/seed-orders.js';
import { DemoBackend } from '../backend/demo.js';
import { executeToolCall } from '../agent/executor.js';
import { Trace } from '../tracing/trace.js';
import type { CompletedSpanPayload } from '../tracing/types.js';
import { DEFAULT_POLICY_CONFIG, PolicyEngine } from '../policy/index.js';
import {
  InMemoryRefundLedger,
  LedgerError,
  customerKeyFor,
  type RefundLedger,
} from '../refund-ledger/index.js';

const order: Order = makeDemoOrders()[0]!;
const orderById = (id: string): Order => makeDemoOrders().find((candidate) => candidate.id === id)!;

type FakeBackendReturnType = {
  backend: OrderBackend;
  ledger: InMemoryRefundLedger;
  requestedIds: string[];
};

/**
 * Fake backend that serves the given stock and records which orders it was
 * asked for. Refunds delegate to a DemoBackend over the same stock, so the
 * refund tool's tests get the real quantity bookkeeping without a second fake.
 */
function fakeBackend(stock: Order[]): FakeBackendReturnType {
  const requestedIds: string[] = [];
  const demo = new DemoBackend(stock);
  const backend: OrderBackend = {
    findOrder: async (orderId) => {
      requestedIds.push(orderId);
      return stock.find((candidate) => candidate.id === orderId) ?? null;
    },
    issueRefund: (key, params) => demo.issueRefund(key, params),
  };
  return { backend, ledger: new InMemoryRefundLedger(), requestedIds };
}

/** Hand-built contexts get decision spans on a throwaway trace: the tool needs a handle, these tests do not read it. */
const scratchTrace = (): Trace =>
  new Trace({
    sessionId: 'scratch',
    providerName: 'anthropic',
    promptName: 'main-agent',
    promptVersion: '0',
    promptHash: 'scratch',
    backendKind: 'demo',
  });

/** The default caps; every test below names amounts relative to them ($100 per call and order, $150 per customer). */
const policyEngine = new PolicyEngine(DEFAULT_POLICY_CONFIG);

const ctx: ToolExecuteContext = {
  callId: 'call_1',
  conversationId: 'conv-registry-test',
  promptHash: 'hash-registry-test',
  signal: new AbortController().signal,
  startPolicyDecisionSpan: (payload) => scratchTrace().startPolicyDecisionSpan(null, payload),
};

/** A context whose decision spans land on one trace, for tests that read the decision back. */
function tracedCtx(callId: string): { ctx: ToolExecuteContext; trace: Trace } {
  const trace = scratchTrace();
  return {
    trace,
    ctx: {
      ...ctx,
      callId,
      startPolicyDecisionSpan: (payload) => trace.startPolicyDecisionSpan(null, payload),
    },
  };
}

type PolicyDecisionSpan = Extract<CompletedSpanPayload, { kind: 'policy_decision' }>;

/** The one policy_decision span of a trace. Ending the trace here also asserts no span was left open. */
function decisionSpanOf(trace: Trace): PolicyDecisionSpan {
  const span = trace
    .end()
    .spans.find(
      (candidate): candidate is PolicyDecisionSpan => candidate.kind === 'policy_decision',
    );
  if (!span) throw new Error('no policy_decision span recorded');
  return span;
}

describe('lookup_order', () => {
  it('returns ok with the sanitized order when the backend finds it', async () => {
    const { backend, ledger } = fakeBackend([order]);
    const registry = createToolRegistry(backend, ledger, policyEngine);
    const result = await registry.lookup_order.execute({ orderId: order.id }, ctx);
    expect(result.resultState).toBe('ok');
    // Sanitization removes exactly the email today; a new sensitive field on
    // Order must consciously update this expectation alongside the allowlist.
    const { email: _email, ...sanitized } = order;
    expect(result.result).toEqual(sanitized);
  });

  it('never leaks the customer email, in neither result nor response', async () => {
    const { backend, ledger } = fakeBackend([order]);
    const registry = createToolRegistry(backend, ledger, policyEngine);
    const result = await registry.lookup_order.execute({ orderId: order.id }, ctx);
    expect(result.result).not.toHaveProperty('email');
    expect(result.response).not.toContain(order.email);
  });

  it('presents money pre-formatted to the model and keeps raw minor units out of its view', async () => {
    const { backend, ledger } = fakeBackend([order]);
    const registry = createToolRegistry(backend, ledger, policyEngine);
    const result = await registry.lookup_order.execute({ orderId: order.id }, ctx);
    const view = JSON.parse(result.response) as {
      items: Record<string, unknown>[];
      total: string;
      createdAt: string;
    };
    // order-1001: 1 × $20.50 + 2 × $45.59 = $111.68 — the model never computes this.
    expect(view.items[0]).toMatchObject({ unitPrice: '$20.50', lineTotal: '$20.50' });
    expect(view.items[1]).toMatchObject({ unitPrice: '$45.59', lineTotal: '$91.18' });
    expect(view.total).toBe('$111.68');
    expect(view.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(result.response).not.toContain('MinorUnits');
    // The trace-facing record still carries the raw values.
    expect(result.result).toMatchObject({ totalMinorUnits: 11168 });
  });

  it('formats non-USD currencies with their own symbol', async () => {
    const euroOrder = makeDemoOrders().find((candidate) => candidate.currency === 'EUR')!;
    const { backend, ledger } = fakeBackend([euroOrder]);
    const registry = createToolRegistry(backend, ledger, policyEngine);
    const result = await registry.lookup_order.execute({ orderId: euroOrder.id }, ctx);
    expect((JSON.parse(result.response) as { total: string }).total).toBe('€159.00');
  });

  it('asks the backend for exactly the requested order id', async () => {
    const { backend, ledger, requestedIds } = fakeBackend([order]);
    const registry = createToolRegistry(backend, ledger, policyEngine);
    await registry.lookup_order.execute({ orderId: order.id }, ctx);
    expect(requestedIds).toEqual([order.id]);
  });

  it('settles as failed — not a throw — when the order does not exist', async () => {
    const { backend, ledger } = fakeBackend([]);
    const registry = createToolRegistry(backend, ledger, policyEngine);
    const result = await registry.lookup_order.execute({ orderId: 'no-such-order' }, ctx);
    expect(result).toEqual({
      resultState: 'failed',
      result: null,
      response: 'Order not found',
    });
  });
});

// The refund tool. Beyond the sanitization boundary, what these pin is the
// result-state rule: three zones in the execute path, and only a throw in
// the first may settle as `failed`.
//   1. before the ledger record: nothing written anywhere → `failed`;
//   2. record written, backend not yet called: nothing has moved;
//   3. backend called: any throw, ledger or otherwise, is `unknown` with a
//      "do not retry" — the money may have moved.
// Response wording is deliberately not pinned here; the model-facing view is
// read back as JSON, and "Do not retry" is the one phrase the rule owns.
/** The model-facing view, parsed back out of the response text. */
const viewIn = (response: string): Record<string, unknown> =>
  JSON.parse(response.slice(response.indexOf('{'))) as Record<string, unknown>;

type LedgerMethod = 'recordRefund' | 'settleRefundRecord' | 'updateRefundRecordStatus';

/** A ledger that delegates everything except the given methods to a real one. */
function ledgerBreakingOn(
  real: InMemoryRefundLedger,
  methods: LedgerMethod[],
  error: () => Error,
): RefundLedger {
  const broken = new Set<LedgerMethod>(methods);
  return {
    recordRefund: (params, queries, decide) =>
      broken.has('recordRefund')
        ? Promise.reject(error())
        : real.recordRefund(params, queries, decide),
    settleRefundRecord: (id, response) =>
      broken.has('settleRefundRecord')
        ? Promise.reject(error())
        : real.settleRefundRecord(id, response),
    updateRefundRecordStatus: (id, status) =>
      broken.has('updateRefundRecordStatus')
        ? Promise.reject(error())
        : real.updateRefundRecordStatus(id, status),
    findRecord: (id) => real.findRecord(id),
    list: () => real.list(),
  };
}

describe('issue_refund', () => {
  const delivered = orderById('order-1005'); // one delivered line, 1 × $79.00
  const args = { orderId: 'order-1005', orderItemId: 'order-1005-line-1', quantity: 1 };
  const refundCtx = (callId: string): ToolExecuteContext => ({ ...ctx, callId });
  it('ok: records before the backend is called, settles ok, and the model reads what actually moved', async () => {
    const { backend, ledger } = fakeBackend([delivered]);
    // Observed from inside the backend call: write-ahead means the record is already there.
    const ledgerDuringBackendCall: string[] = [];
    const observing: OrderBackend = {
      ...backend,
      issueRefund: async (key, params) => {
        ledgerDuringBackendCall.push(...(await ledger.list()).map((record) => record.status));
        return backend.issueRefund(key, params);
      },
    };
    const registry = createToolRegistry(observing, ledger, policyEngine);

    const result = await registry.issue_refund.execute(args, refundCtx('call-ok'));

    expect(result.resultState).toBe('ok');
    expect(ledgerDuringBackendCall).toEqual(['attempted']);

    const [record] = await ledger.list();
    expect(record).toMatchObject({
      status: 'ok',
      orderId: 'order-1005',
      orderItemId: 'order-1005-line-1',
      quantity: 1,
      amountMinorUnits: 7900,
      currency: 'USD',
      refundedAmountMinorUnits: 7900,
      refundedAmountCurrency: 'USD',
      backendRefundId: expect.any(String),
      callId: 'call-ok',
      conversationId: ctx.conversationId,
      promptHash: ctx.promptHash,
      customerKey: customerKeyFor(delivered),
    });
    // Trace-facing: the whole record. Model-facing: the allowlisted view only.
    expect(result.result).toEqual(record);
    expect(viewIn(result.response)).toEqual({
      status: 'ok',
      orderId: 'order-1005',
      orderItemId: 'order-1005-line-1',
      quantity: 1,
      currency: 'USD',
      refundId: record!.backendRefundId,
      amount: '$79.00',
    });
  });

  it('never carries the customer key, the email or raw minor units in the response', async () => {
    const { backend, ledger } = fakeBackend([delivered]);
    const registry = createToolRegistry(backend, ledger, policyEngine);
    const result = await registry.issue_refund.execute(args, refundCtx('call-key'));
    expect(result.resultState).toBe('ok');
    expect(result.response).not.toContain(customerKeyFor(delivered));
    expect(result.response).not.toContain(delivered.email);
    expect(result.response).not.toContain('MinorUnits');
    expect(result.response).not.toContain(ctx.promptHash);
  });

  it('over-quantity is denied by eligibility before the backend is asked', async () => {
    const { backend, ledger } = fakeBackend([delivered]);
    const registry = createToolRegistry(backend, ledger, policyEngine);
    const result = await registry.issue_refund.execute(
      { ...args, quantity: 2 },
      refundCtx('call-over'),
    );
    expect(result.resultState).toBe('failed');
    expect(result.response).toContain('requested_exceeds_delivered');
    expect(await ledger.list()).toEqual([]);
  });

  it('backend refuses what the ledger allowed (refunded outside Kept): the record settles failed, resultState is failed', async () => {
    // The backend already holds a refund the ledger never saw, so eligibility
    // passes on the ledger's view and the backend's own invariant refuses.
    const demo = new DemoBackend([delivered], { 'order-1005': { 'order-1005-line-1': 1 } });
    const backend: OrderBackend = {
      findOrder: (orderId) => demo.findOrder(orderId),
      issueRefund: (key, params) => demo.issueRefund(key, params),
    };
    const ledger = new InMemoryRefundLedger();
    const registry = createToolRegistry(backend, ledger, policyEngine);
    const result = await registry.issue_refund.execute(args, refundCtx('call-disagree'));
    expect(result.resultState).toBe('failed');
    expect(result.response).toContain('quantity_exceeds_unrefunded');
    expect((await ledger.list()).map((record) => record.status)).toEqual(['failed']);
  });

  it.each([
    ['quantity 0', { ...args, quantity: 0 }],
    ['negative quantity', { ...args, quantity: -1 }],
    ['fractional quantity', { ...args, quantity: 0.5 }],
    ['unknown order', { ...args, orderId: 'no-such-order' }],
    ['unknown line', { ...args, orderItemId: 'no-such-line' }],
  ])('%s fails in zone 1: nothing written, backend never asked', async (_label, input) => {
    const { backend, ledger } = fakeBackend([delivered]);
    let refundCalls = 0;
    const counting: OrderBackend = {
      ...backend,
      issueRefund: (key, params) => {
        refundCalls += 1;
        return backend.issueRefund(key, params);
      },
    };
    const registry = createToolRegistry(counting, ledger, policyEngine);
    const result = await registry.issue_refund.execute(input, refundCtx('call-zone1'));
    expect(result.resultState).toBe('failed');
    expect(await ledger.list()).toEqual([]);
    expect(refundCalls).toBe(0);
  });

  it('unknown backend outcome: the record settles unknown, resultState is unknown, response says do not retry', async () => {
    const { backend, ledger } = fakeBackend([delivered]);
    const vanishing: OrderBackend = {
      ...backend,
      issueRefund: async () => ({ status: 'unknown' }),
    };
    const registry = createToolRegistry(vanishing, ledger, policyEngine);
    const result = await registry.issue_refund.execute(args, refundCtx('call-unknown'));
    expect(result.resultState).toBe('unknown');
    expect(result.response).toContain('Do not retry');
    expect((await ledger.list()).map((record) => record.status)).toEqual(['unknown']);
  });

  it.each([
    ['a LedgerError', (): Error => new LedgerError('record_not_found', 'gone')],
    ['a plain Error', (): Error => new Error('ledger connection lost')],
  ])(
    '%s from the ledger after the backend answered ok settles as unknown, never failed',
    async (_label, error) => {
      const { backend, ledger } = fakeBackend([delivered]);
      const registry = createToolRegistry(
        backend,
        ledgerBreakingOn(ledger, ['settleRefundRecord'], error),
        policyEngine,
      );

      const result = await registry.issue_refund.execute(args, refundCtx('call-settle-throw'));

      expect(result.resultState).toBe('unknown');
      expect(result.response).toContain('Do not retry');
      // The backend's answer survives in the trace, and the money did move:
      // the line is now fully refunded at the backend.
      expect(result.result).toMatchObject({
        backendResponse: { status: 'ok', amountMinorUnits: 7900 },
      });
      expect(await backend.issueRefund('probe', args)).toMatchObject({
        errorType: 'quantity_exceeds_unrefunded',
      });
      // The reconciliation in the catch told the ledger what the tool knows: unknown.
      expect((await ledger.list()).map((record) => record.status)).toEqual(['unknown']);
    },
  );

  it('a ledger throw before the backend is called settles as failed, the backend is never asked, and the decision span is errored, not left open', async () => {
    const { backend, ledger } = fakeBackend([delivered]);
    let refundCalls = 0;
    const counting: OrderBackend = {
      ...backend,
      issueRefund: (key, params) => {
        refundCalls += 1;
        return backend.issueRefund(key, params);
      },
    };
    const registry = createToolRegistry(
      counting,
      ledgerBreakingOn(ledger, ['recordRefund'], () => new Error('ledger down')),
      policyEngine,
    );
    const { ctx: traced, trace } = tracedCtx('call-record-throw');

    // Through the executor: its catch is the contract for zone 1.
    const settled = await executeToolCall(registry, {
      callId: traced.callId,
      name: 'issue_refund',
      conversationId: traced.conversationId,
      promptHash: traced.promptHash,
      startPolicyDecisionSpan: traced.startPolicyDecisionSpan,
      args,
    });

    expect(settled.resultState).toBe('failed');
    expect(refundCalls).toBe(0);
    expect(await ledger.list()).toEqual([]);
    // Outside production an open span makes trace.end() throw; this one was errored on the way out.
    expect(decisionSpanOf(trace)).toMatchObject({ status: 'error', errorType: 'decision_failed' });
  });

  it('settle and the reconciliation both throwing after the backend answered still settles as unknown, with both errors in the trace', async () => {
    const { backend, ledger } = fakeBackend([delivered]);
    const registry = createToolRegistry(
      backend,
      ledgerBreakingOn(
        ledger,
        ['settleRefundRecord', 'updateRefundRecordStatus'],
        () => new Error('ledger down'),
      ),
      policyEngine,
    );

    const result = await registry.issue_refund.execute(args, refundCtx('call-double-throw'));

    expect(result.resultState).toBe('unknown');
    expect(result.response).toContain('Do not retry');
    expect(result.result).toMatchObject({
      status: 'unknown',
      error: { errorMessage: 'ledger down' },
      reconciliationError: { errorMessage: 'ledger down' },
      backendResponse: { status: 'ok', amountMinorUnits: 7900 },
      ledgerRecord: null,
    });
    // Unreconciled: the record keeps the crash signature, attempted with no backend fields.
    expect((await ledger.list()).map((record) => record.status)).toEqual(['attempted']);
  });

  it('require_approval: the record is pending, the backend is never asked, the model is told not to retry or split', async () => {
    const jacket = orderById('order-1004'); // 1 × €159.00, over the per-call cap
    const { backend, ledger } = fakeBackend([jacket]);
    let refundCalls = 0;
    const counting: OrderBackend = {
      ...backend,
      issueRefund: (key, params) => {
        refundCalls += 1;
        return backend.issueRefund(key, params);
      },
    };
    const registry = createToolRegistry(counting, ledger, policyEngine);
    const { ctx: traced, trace } = tracedCtx('call-approval');

    const result = await registry.issue_refund.execute(
      { orderId: 'order-1004', orderItemId: 'order-1004-line-1', quantity: 1 },
      traced,
    );

    expect(result.resultState).toBe('ok');
    expect(result.response).toContain('NOT issued');
    expect(result.response).toContain('Do not retry');
    expect(result.response).toContain('do not split');
    expect(result.response).not.toMatch(/\d/); // no amounts, limits or ids reach the model
    expect(refundCalls).toBe(0);
    expect((await ledger.list()).map((record) => record.status)).toEqual(['pending']);
    expect(decisionSpanOf(trace)).toMatchObject({
      status: 'completed',
      outcome: 'require_approval',
      reason: 'cap_exceeded',
      configHash: policyEngine.configHash,
    });
  });

  it('deny, not eligible: nothing is written, the backend is never asked, the reason reaches the model as a code', async () => {
    const inTransit = orderById('order-1001');
    const { backend, ledger } = fakeBackend([inTransit]);
    let refundCalls = 0;
    const counting: OrderBackend = {
      ...backend,
      issueRefund: (key, params) => {
        refundCalls += 1;
        return backend.issueRefund(key, params);
      },
    };
    const registry = createToolRegistry(counting, ledger, policyEngine);
    const { ctx: traced, trace } = tracedCtx('call-deny');

    const result = await registry.issue_refund.execute(
      { orderId: 'order-1001', orderItemId: 'order-1001-line-1', quantity: 1 },
      traced,
    );

    expect(result.resultState).toBe('failed');
    expect(result.response).toContain('not eligible');
    expect(result.response).toContain('nothing_delivered_on_line');
    expect(result.response).toContain('Do not retry');
    expect(refundCalls).toBe(0);
    expect(await ledger.list()).toEqual([]);
    expect(decisionSpanOf(trace)).toMatchObject({ outcome: 'deny', reason: 'not_eligible' });
  });

  it('deny, already requested: a second ask for a held line is refused without a second record', async () => {
    const { backend, ledger } = fakeBackend([delivered]);
    const registry = createToolRegistry(backend, ledger, policyEngine);

    const first = await registry.issue_refund.execute(args, refundCtx('call-first'));
    const { ctx: traced, trace } = tracedCtx('call-again');
    const again = await registry.issue_refund.execute(args, traced);

    expect(first.resultState).toBe('ok');
    expect(again.resultState).toBe('failed');
    expect(again.response).toContain('already recorded or under review');
    expect(again.response).not.toContain('not eligible');
    expect(await ledger.list()).toHaveLength(1);
    expect(decisionSpanOf(trace)).toMatchObject({ outcome: 'deny', reason: 'already_requested' });
  });

  it('split refund through the tool: the second line lands in the queue with the first as its context', async () => {
    const boots = orderById('order-1002');
    const { backend, ledger } = fakeBackend([boots]);
    const registry = createToolRegistry(backend, ledger, policyEngine);

    const first = await registry.issue_refund.execute(
      { orderId: 'order-1002', orderItemId: 'order-1002-line-1', quantity: 1 }, // 1 × $89.00
      refundCtx('call-boots'),
    );
    const { ctx: traced, trace } = tracedCtx('call-insoles');
    const second = await registry.issue_refund.execute(
      { orderId: 'order-1002', orderItemId: 'order-1002-line-2', quantity: 1 }, // 1 × $12.00
      traced,
    );

    expect(first.resultState).toBe('ok');
    expect(viewIn(first.response)).toMatchObject({ status: 'ok', amount: '$89.00' });
    expect(second.resultState).toBe('ok');
    expect(second.response).toContain('NOT issued');
    const [bootsRecord, insolesRecord] = await ledger.list();
    expect(bootsRecord?.status).toBe('ok');
    expect(insolesRecord?.status).toBe('pending');
    // The model is blind to the math; the trace is not.
    expect(second.response).not.toContain('$89.00');
    expect(second.response).not.toContain(bootsRecord!.backendRefundId!);
    const perOrder = decisionSpanOf(trace).decision?.perCap.find((row) => row.kind === 'per_order');
    expect(perOrder).toMatchObject({
      outcome: 'require_approval',
      consumedAmountMinorUnits: 8900,
      requestedAmountMinorUnits: 1200,
      contributingRecordIds: [bootsRecord!.id],
    });
  });

  it('never reports prior refunds, limits or consumed amounts to the model; the trace carries them', async () => {
    const boots = orderById('order-1002'); // same customer as order-1005
    const { backend, ledger } = fakeBackend([boots, delivered]);
    const registry = createToolRegistry(backend, ledger, policyEngine);

    const first = await registry.issue_refund.execute(
      { orderId: 'order-1002', orderItemId: 'order-1002-line-1', quantity: 1 }, // 1 × $89.00
      refundCtx('call-first'),
    );
    const { ctx: traced, trace } = tracedCtx('call-second');
    const second = await registry.issue_refund.execute(args, traced); // 1 × $79.00: $168 for the customer

    expect(first.resultState).toBe('ok');
    expect(second.resultState).toBe('ok');
    expect(second.response).toContain('NOT issued');
    const [firstRecord] = await ledger.list();
    expect(second.response).not.toContain(firstRecord!.backendRefundId!);
    expect(second.response).not.toContain('$89.00');
    expect(second.response).not.toMatch(/\d/);
    const perCustomer = decisionSpanOf(trace).decision?.perCap.find(
      (row) => row.kind === 'per_customer',
    );
    expect(perCustomer).toMatchObject({
      outcome: 'require_approval',
      consumedAmountMinorUnits: 8900,
      contributingRecordIds: [firstRecord!.id],
    });
  });
});
