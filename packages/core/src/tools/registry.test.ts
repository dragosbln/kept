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

  it('serializes the model-facing response from the sanitized order', async () => {
    const { backend } = fakeBackend([order]);
    const registry = createToolRegistry(backend);
    const result = await registry.lookup_order.execute({ orderId: order.id }, ctx);
    expect(JSON.parse(result.response)).toEqual(result.result);
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
