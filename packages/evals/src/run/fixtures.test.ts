// The fixture builder: ages become epochs on the case clock, prior refunds
// get the fields the ledger needs from the order, and the backend learns
// what was already refunded.

import { describe, expect, it } from 'vitest';
import { COUNTING_STATUSES, customerKeyFor, makeDemoOrders } from '@kept-hq/core';
import { parseEvalCase } from '../case/schema.js';
import { FIXTURE_STAMP, materializeFixtures } from './fixtures.js';

const NOW = Date.UTC(2026, 8, 10, 12);
const DAY = 86_400_000;

const base = {
  id: 'fixtures',
  title: 'Fixtures',
  storeId: 'loomhaven',
  clock: '2026-09-10T12:00:00Z',
  steps: [{ kind: 'customer_message', message: 'hi' }],
  assertions: [{ kind: 'turn_outcome', expected: { type: 'reply' } }],
};

describe('materializeFixtures', () => {
  it('ages the demo seed from the case clock, and a case order replaces a seed order by id', () => {
    const evalCase = parseEvalCase({
      ...base,
      fixtures: {
        orders: [
          {
            id: 'order-1002',
            email: 'sam@example.com',
            status: 'delivered',
            currency: 'USD',
            ageMs: 2 * DAY,
            items: [
              {
                id: 'order-1002-line-1',
                productId: 'boot-trail',
                productName: 'Trail Boots',
                quantity: 1,
                unitPriceMinorUnits: 8900,
              },
            ],
          },
        ],
      },
    });
    const { orders, priorRefunds, refundedItems } = materializeFixtures(evalCase, NOW);
    expect(orders).toHaveLength(makeDemoOrders().length);
    const seed = orders.find((order) => order.id === 'order-1001');
    expect(seed?.createdAt).toBe(NOW - 3 * DAY);
    const replaced = orders.find((order) => order.id === 'order-1002');
    expect(replaced).toMatchObject({
      createdAt: NOW - 2 * DAY,
      updatedAt: NOW - 2 * DAY,
      totalMinorUnits: 8900,
      shipments: [],
    });
    expect(priorRefunds).toEqual([]);
    expect(refundedItems).toEqual({});
  });

  it('without the seed, only the case orders exist', () => {
    const evalCase = parseEvalCase({ ...base, fixtures: { seedDemoOrders: false } });
    expect(materializeFixtures(evalCase, NOW).orders).toEqual([]);
  });

  it('a prior refund derives amount, currency and customer key from the order, and is aged', () => {
    const evalCase = parseEvalCase({
      ...base,
      fixtures: {
        priorRefunds: [
          {
            orderId: 'order-1005',
            orderItemId: 'order-1005-line-1',
            quantity: 1,
            status: 'ok',
            ageMs: 5 * DAY,
          },
          {
            orderId: 'order-1002',
            orderItemId: 'order-1002-line-2',
            quantity: 1,
            status: 'pending',
            ageMs: DAY,
          },
        ],
      },
    });
    const { priorRefunds, refundedItems, orders } = materializeFixtures(evalCase, NOW);
    const sam = customerKeyFor({ email: 'sam@example.com' });
    expect(priorRefunds[0]).toMatchObject({
      id: `${FIXTURE_STAMP}-refund-1`,
      idempotencyKey: `${FIXTURE_STAMP}-refund-1`,
      orderId: 'order-1005',
      amountMinorUnits: 7900,
      currency: 'USD',
      customerKey: sam,
      createdAt: NOW - 5 * DAY,
      status: 'ok',
      refundedAmountMinorUnits: 7900,
      refundedAmountCurrency: 'USD',
      decisionRecord: { outcome: 'allow' },
    });
    expect(priorRefunds[1]).toMatchObject({
      amountMinorUnits: 1200,
      status: 'pending',
      decisionRecord: { outcome: 'require_approval', reason: 'cap_exceeded' },
    });
    expect(priorRefunds[1]).not.toHaveProperty('refundedAmountMinorUnits');
    // Both count toward caps; only the executed one is money the backend moved.
    expect(priorRefunds.every((record) => COUNTING_STATUSES.has(record.status))).toBe(true);
    expect(refundedItems).toEqual({ 'order-1005': { 'order-1005-line-1': 1 } });
    expect(orders.some((order) => order.id === 'order-1005')).toBe(true);
  });

  it('a prior refund on an unknown order or line is a fixture error that names the entry', () => {
    const noOrder = parseEvalCase({
      ...base,
      fixtures: {
        priorRefunds: [
          { orderId: 'order-9', orderItemId: 'x', quantity: 1, status: 'ok', ageMs: 0 },
        ],
      },
    });
    expect(() => materializeFixtures(noOrder, NOW)).toThrow(/priorRefunds\[0\]: no order order-9/);
    const noLine = parseEvalCase({
      ...base,
      fixtures: {
        priorRefunds: [
          {
            orderId: 'order-1005',
            orderItemId: 'order-1005-line-9',
            quantity: 1,
            status: 'ok',
            ageMs: 0,
          },
        ],
      },
    });
    expect(() => materializeFixtures(noLine, NOW)).toThrow(/has no line order-1005-line-9/);
  });
});
