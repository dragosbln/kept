// Unit tests for refundAmountFor. The amount is a property of the canonical
// order, never of the caller: the model names a line and a quantity, the
// ledger records what that is worth before the backend answers.

import { describe, expect, it } from 'vitest';
import { refundAmountFor } from './utils.js';
import { makeDemoOrders } from './seed-orders.js';
import type { Order } from './types.js';

const orderById = (id: string): Order => makeDemoOrders().find((order) => order.id === id)!;

describe('refundAmountFor', () => {
  it('is unit price × quantity in the order currency', () => {
    // order-1001 line 2: Wool Socks, 2 × $45.59.
    expect(refundAmountFor(orderById('order-1001'), 'order-1001-line-2', 2)).toEqual({
      amountMinorUnits: 9118,
      currency: 'USD',
    });
  });

  it('follows the order currency, not a default', () => {
    expect(refundAmountFor(orderById('order-1004'), 'order-1004-line-1', 1)).toEqual({
      amountMinorUnits: 15900,
      currency: 'EUR',
    });
  });

  it('throws on a line the order does not have: a caller bug, caught before any write', () => {
    expect(() => refundAmountFor(orderById('order-1005'), 'order-1004-line-1', 1)).toThrow(
      /order-1005 has no line order-1004-line-1/,
    );
  });
});
