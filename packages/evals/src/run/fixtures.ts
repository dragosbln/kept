// Turns a case's fixtures into what the factory seeds: orders with real
// timestamps, and ledger records with the fields a case author cannot
// write. A case names an order, a line and a quantity; the amount, the
// currency and the customer key come from the order, the way the tool
// derives them at runtime.

import {
  customerKeyFor,
  makeDemoOrders,
  refundAmountFor,
  type DecisionResult,
  type Order,
  type PolicyRequest,
  type RefundLedgerRecord,
} from '@kept-hq/core';
import type { EvalCase, FixtureOrder, PriorRefund } from '../case/schema.js';
import type { RefundedItems } from './types.js';

export type MaterializedFixtures = {
  orders: Order[];
  /** What the backend must already count as refunded: the `ok` prior refunds, per line. */
  refundedItems: RefundedItems;
  priorRefunds: RefundLedgerRecord[];
};

/** Stamped on synthesized records where a real run would stamp a hash or an id; visibly not a real one. */
export const FIXTURE_STAMP = 'fixture';

function orderFromFixture(fixture: FixtureOrder, now: number): Order {
  const createdAt = now - fixture.ageMs;
  const items = fixture.items.map((item) => ({ ...item }));
  return {
    id: fixture.id,
    createdAt,
    updatedAt: createdAt,
    email: fixture.email,
    status: fixture.status,
    currency: fixture.currency,
    items,
    totalMinorUnits: items.reduce((sum, item) => sum + item.unitPriceMinorUnits * item.quantity, 0),
    shipments: fixture.shipments.map((shipment) => ({
      ...shipment,
      items: shipment.items.map((line) => ({ ...line })),
    })),
  };
}

/**
 * A prior refund as the ledger would hold it. The decision that opened it
 * is synthesized to match its status: a pending or denied record came from
 * a require_approval, everything else from an allow. An `ok` record also
 * carries what the backend moved, so the caps consume the moved amount.
 */
function recordFromPrior(
  prior: PriorRefund,
  index: number,
  orders: ReadonlyMap<string, Order>,
  now: number,
): RefundLedgerRecord {
  const label = `fixtures.priorRefunds[${index}]`;
  const order = orders.get(prior.orderId);
  if (!order) {
    throw new Error(`${label}: no order ${prior.orderId} among the fixtures`);
  }
  if (!order.items.some((item) => item.id === prior.orderItemId)) {
    throw new Error(`${label}: order ${prior.orderId} has no line ${prior.orderItemId}`);
  }
  const amount = refundAmountFor(order, prior.orderItemId, prior.quantity);
  const request: PolicyRequest = {
    action: 'issue_refund',
    customerKey: customerKeyFor(order),
    orderId: prior.orderId,
    orderItemId: prior.orderItemId,
    quantity: prior.quantity,
    ...amount,
  };
  const record = { configHash: FIXTURE_STAMP, request, eligibility: [], perCap: [] };
  const decisionRecord: DecisionResult =
    prior.status === 'pending' || prior.status === 'denied'
      ? { outcome: 'require_approval', reason: 'cap_exceeded', record }
      : { outcome: 'allow', record };
  const id = `${FIXTURE_STAMP}-refund-${index + 1}`;
  return {
    id,
    idempotencyKey: id,
    callId: `${FIXTURE_STAMP}-call-${index + 1}`,
    orderId: prior.orderId,
    orderItemId: prior.orderItemId,
    quantity: prior.quantity,
    customerKey: request.customerKey,
    conversationId: FIXTURE_STAMP,
    promptHash: FIXTURE_STAMP,
    amountMinorUnits: amount.amountMinorUnits,
    currency: amount.currency,
    createdAt: now - prior.ageMs,
    decisionRecord,
    status: prior.status,
    ...(prior.status === 'ok'
      ? {
          backendRefundId: `${FIXTURE_STAMP}-backend-${index + 1}`,
          refundedAmountMinorUnits: amount.amountMinorUnits,
          refundedAmountCurrency: amount.currency,
        }
      : {}),
  };
}

/**
 * The demo seed is aged from the case clock, so "delivered six days ago"
 * means six days before the clock, not before the wall. A case order with
 * the same id as a seed order replaces it.
 */
export function materializeFixtures(evalCase: EvalCase, now: number): MaterializedFixtures {
  const { fixtures } = evalCase;
  const byId = new Map<string, Order>();
  if (fixtures.seedDemoOrders) {
    for (const order of makeDemoOrders(now)) byId.set(order.id, order);
  }
  for (const fixture of fixtures.orders) byId.set(fixture.id, orderFromFixture(fixture, now));

  const priorRefunds = fixtures.priorRefunds.map((prior, index) =>
    recordFromPrior(prior, index, byId, now),
  );
  const refundedItems: RefundedItems = {};
  for (const record of priorRefunds) {
    if (record.status !== 'ok') continue;
    const perLine = refundedItems[record.orderId] ?? {};
    perLine[record.orderItemId] = (perLine[record.orderItemId] ?? 0) + record.quantity;
    refundedItems[record.orderId] = perLine;
  }
  return { orders: [...byId.values()], refundedItems, priorRefunds };
}
