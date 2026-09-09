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

const order: Order = makeDemoOrders()[0]!;

type FakeBackendReturnType = {
  backend: OrderBackend;
  requestedIds: string[];
};

/** Fake backend that serves one order and records what it was asked for. */
function fakeBackend(stock: Order[]): FakeBackendReturnType {
  const requestedIds: string[] = [];
  const backend: OrderBackend = {
    findOrder: async (orderId) => {
      requestedIds.push(orderId);
      return stock.find((candidate) => candidate.id === orderId) ?? null;
    },
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
