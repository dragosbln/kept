// Unit tests for the tool registry's execute functions, run against a fake
// OrderBackend. The load-bearing assertions are the sanitization boundary:
// nothing past sanitizeOrderForModel may carry sensitiveField, in either the
// model-facing response or the trace-facing result.

import { describe, expect, it } from 'vitest';
import { createToolRegistry } from './registry.js';
import type { ToolExecuteContext } from './types.js';
import type { Order } from '../backend/types.js';
import type { OrderBackend } from '../backend/order-backend.js';

const order: Order = {
  id: 'order-7',
  createdAt: 1_756_000_000_000,
  sensitiveField: 'do-not-disclose',
};

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

const ctx: ToolExecuteContext = { callId: 'call_1' };

describe('lookup_order', () => {
  it('returns ok with the sanitized order when the backend finds it', async () => {
    const { backend } = fakeBackend([order]);
    const registry = createToolRegistry(backend);
    const result = await registry.lookup_order.execute({ orderId: 'order-7' }, ctx);
    expect(result.resultState).toBe('ok');
    expect(result.result).toEqual({ id: 'order-7', createdAt: 1_756_000_000_000 });
  });

  it('never leaks sensitiveField, in neither result nor response', async () => {
    const { backend } = fakeBackend([order]);
    const registry = createToolRegistry(backend);
    const result = await registry.lookup_order.execute({ orderId: 'order-7' }, ctx);
    expect(result.result).not.toHaveProperty('sensitiveField');
    expect(result.response).not.toContain('do-not-disclose');
  });

  it('serializes the model-facing response from the sanitized order', async () => {
    const { backend } = fakeBackend([order]);
    const registry = createToolRegistry(backend);
    const result = await registry.lookup_order.execute({ orderId: 'order-7' }, ctx);
    expect(JSON.parse(result.response)).toEqual(result.result);
  });

  it('asks the backend for exactly the requested order id', async () => {
    const { backend, requestedIds } = fakeBackend([order]);
    const registry = createToolRegistry(backend);
    await registry.lookup_order.execute({ orderId: 'order-7' }, ctx);
    expect(requestedIds).toEqual(['order-7']);
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
