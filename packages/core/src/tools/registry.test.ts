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

const order: Order = makeDemoOrders()[0]!;

type FakeBackendReturnType = {
  backend: OrderBackend;
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
    issueRefund: (params) => demo.issueRefund(params),
  };
  return { backend, requestedIds };
}

const ctx: ToolExecuteContext = { callId: 'call_1', signal: new AbortController().signal };

describe('lookup_order', () => {
  it('returns ok with the sanitized order when the backend finds it', async () => {
    const { backend } = fakeBackend([order]);
    const registry = createToolRegistry(backend);
    const result = await registry.lookup_order.execute({ orderId: order.id }, ctx);
    expect(result.resultState).toBe('ok');
    // Sanitization removes exactly the email today; a new sensitive field on
    // Order must consciously update this expectation alongside the allowlist.
    const { email: _email, ...sanitized } = order;
    expect(result.result).toEqual(sanitized);
  });

  it('never leaks the customer email, in neither result nor response', async () => {
    const { backend } = fakeBackend([order]);
    const registry = createToolRegistry(backend);
    const result = await registry.lookup_order.execute({ orderId: order.id }, ctx);
    expect(result.result).not.toHaveProperty('email');
    expect(result.response).not.toContain(order.email);
  });

  it('presents money pre-formatted to the model and keeps raw minor units out of its view', async () => {
    const { backend } = fakeBackend([order]);
    const registry = createToolRegistry(backend);
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
    const { backend } = fakeBackend([euroOrder]);
    const registry = createToolRegistry(backend);
    const result = await registry.lookup_order.execute({ orderId: euroOrder.id }, ctx);
    expect((JSON.parse(result.response) as { total: string }).total).toBe('€159.00');
  });

  it('asks the backend for exactly the requested order id', async () => {
    const { backend, requestedIds } = fakeBackend([order]);
    const registry = createToolRegistry(backend);
    await registry.lookup_order.execute({ orderId: order.id }, ctx);
    expect(requestedIds).toEqual([order.id]);
  });

  it('settles as failed — not a throw — when the order does not exist', async () => {
    const { backend } = fakeBackend([]);
    const registry = createToolRegistry(backend);
    const result = await registry.lookup_order.execute({ orderId: 'no-such-order' }, ctx);
    expect(result).toEqual({
      resultState: 'failed',
      result: null,
      response: 'Order not found',
    });
  });
});

// Step 4 (the refund tool) turns these green. They are written down now so
// the result-state rule is pinned before the tool exists: three zones in the
// execute path, and only a throw in the first one may settle as `failed`.
//   1. before the ledger record: nothing written anywhere → `failed` (the
//      executor's own catch is enough);
//   2. record written, backend not yet called: nothing moved, but the
//      `attempted` record must be settled `failed` before returning;
//   3. backend called: any throw, ledger or otherwise, is `unknown` with a
//      "do not retry" — the money may have moved.
describe('issue_refund', () => {
  it.todo('ok: records write-ahead, settles ok, and the response never carries the customer key');
  it.todo('over-quantity: the backend refuses, the record settles failed, resultState is failed');
  it.todo(
    'unknown backend outcome: the record settles unknown, resultState is unknown, response says do not retry',
  );
  it.todo('a ledger throw after the backend answered ok settles as unknown, never failed');
  it.todo(
    'a ledger throw before the backend is called settles as failed and leaves no attempted record',
  );
  it.todo('never reports prior refunds in the response (v1.0 blindness is the experiment)');
});
