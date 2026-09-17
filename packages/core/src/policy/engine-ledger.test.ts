// The engine and the ledger together, the way the tool will drive them:
// plan, then recordRefund with the plan's queries and decide as the closure.
// These are the week-2 checkpoint scenarios on the demo fixtures, with the
// tool and the prompt out of the picture:
// - split refund on one order (scripts 1 and 2) dies at the per-order cap
//   and lands as pending with the caps math attached, also when both
//   requests arrive in one tool round;
// - asking again for a line that is already held is a deny, not a second
//   pending record;
// - the per-customer cap across two orders (script 5), and the same request
//   allowed once the earlier refund has left the trailing window.

import { describe, expect, it } from 'vitest';
import { makeDemoOrders, DEMO_SEED_EPOCH } from '../backend/seed-orders.js';
import { refundAmountFor, sanitizeOrderForModel } from '../backend/utils.js';
import { customerKeyFor } from '../refund-ledger/customer-key.js';
import { InMemoryRefundLedger } from '../refund-ledger/in-memory-refund-ledger.js';
import type { RecordRefundResult, RefundLedgerRecord } from '../refund-ledger/types.js';
import { DEFAULT_POLICY_CONFIG } from './config.js';
import { PolicyEngine } from './engine.js';
import type { CapDecision, CapKind } from './index.js';

const DAY = 24 * 3_600_000;

const ORDERS = new Map(makeDemoOrders(DEMO_SEED_EPOCH).map((order) => [order.id, order]));

type World = { clock: { now: number }; engine: PolicyEngine; ledger: InMemoryRefundLedger };

/** One clock for both, movable, so a test can let a refund age past a window. */
function setup(): World {
  const clock = { now: DEMO_SEED_EPOCH };
  const now = (): number => clock.now;
  return {
    clock,
    engine: new PolicyEngine(DEFAULT_POLICY_CONFIG, { now }),
    ledger: new InMemoryRefundLedger([], now),
  };
}

/** The tool's sequence, minus the tool: derive the request, plan, record with decide as the closure. */
function ask(
  { engine, ledger }: World,
  orderId: string,
  orderItemId: string,
  quantity: number,
  callId: string,
): Promise<RecordRefundResult> {
  const order = ORDERS.get(orderId);
  if (!order) throw new Error(`no demo order ${orderId}`);
  const amount = refundAmountFor(order, orderItemId, quantity);
  const customerKey = customerKeyFor(order);
  const plan = engine.plan(
    { action: 'issue_refund', customerKey, orderId, orderItemId, quantity, ...amount },
    sanitizeOrderForModel(order),
  );
  return ledger.recordRefund(
    {
      callId,
      conversationId: 'conv-1',
      promptHash: 'hash-1',
      orderId,
      orderItemId,
      quantity,
      customerKey,
      ...amount,
    },
    plan.entries.map((entry) => entry.query),
    (results) => engine.decide(plan, results),
  );
}

/** Narrows to the written variants of the result; a deny here is a test bug. */
function written(
  result: RecordRefundResult,
): Extract<RecordRefundResult, { ledgerRecord: RefundLedgerRecord }> {
  if (result.outcome === 'deny') throw new Error('expected a written record, got deny');
  return result;
}

const rowsByKind = (result: RecordRefundResult): Partial<Record<CapKind, CapDecision>> =>
  Object.fromEntries(result.record.perCap.map((row) => [row.kind, row]));

describe('policy engine + ledger', () => {
  it('split refund: the second line trips the per-order cap and lands as pending with the math', async () => {
    const world = setup();

    const boots = written(await ask(world, 'order-1002', 'order-1002-line-1', 1, 'call-boots')); // $89
    const insoles = written(await ask(world, 'order-1002', 'order-1002-line-2', 1, 'call-insoles')); // $12

    expect(boots.outcome).toBe('allow');
    expect(boots.ledgerRecord.status).toBe('attempted');

    expect(insoles).toMatchObject({ outcome: 'require_approval', reason: 'cap_exceeded' });
    expect(insoles.ledgerRecord.status).toBe('pending');
    const rows = rowsByKind(insoles);
    expect(rows.per_call).toMatchObject({ outcome: 'allow' });
    expect(rows.per_order).toMatchObject({
      outcome: 'require_approval',
      consumedAmountMinorUnits: 8900,
      requestedAmountMinorUnits: 1200,
      remainingBeforeMinorUnits: 1100,
      contributingRecordIds: [boots.ledgerRecord.id],
    });
    expect(rows.per_customer).toMatchObject({ outcome: 'allow', consumedAmountMinorUnits: 8900 });
    expect(rows.per_day).toMatchObject({ outcome: 'allow', consumedAmountMinorUnits: 8900 });
  });

  it('split refund in one tool round: exactly one request passes', async () => {
    const world = setup();

    const [boots, insoles] = await Promise.all([
      ask(world, 'order-1002', 'order-1002-line-1', 1, 'call-boots'),
      ask(world, 'order-1002', 'order-1002-line-2', 1, 'call-insoles'),
    ]);

    expect([boots.outcome, insoles.outcome].toSorted()).toEqual(['allow', 'require_approval']);
    expect((await world.ledger.list()).map((record) => record.status).toSorted()).toEqual([
      'attempted',
      'pending',
    ]);
  });

  it('asking again for a line that is already held is denied as already requested and writes nothing', async () => {
    const world = setup();

    await ask(world, 'order-1002', 'order-1002-line-1', 1, 'call-first');
    const again = await ask(world, 'order-1002', 'order-1002-line-1', 1, 'call-again');

    expect(again.outcome).toBe('deny');
    expect(again).toMatchObject({ outcome: 'deny', reason: 'already_requested' });
    expect(again).not.toHaveProperty('ledgerRecord');
    expect(await world.ledger.list()).toHaveLength(1);
  });

  it('per-customer cap across two orders, and the same request allowed once the first refund leaves the window', async () => {
    const world = setup();

    const layer = written(await ask(world, 'order-1005', 'order-1005-line-1', 1, 'call-layer')); // $79, same customer
    expect(layer.outcome).toBe('allow');

    // Two days on: outside the per-day window, well inside the per-customer one.
    world.clock.now += 2 * DAY;
    const boots = written(await ask(world, 'order-1002', 'order-1002-line-1', 1, 'call-boots')); // $89
    expect(boots).toMatchObject({ outcome: 'require_approval', reason: 'cap_exceeded' });
    expect(rowsByKind(boots).per_customer).toMatchObject({
      outcome: 'require_approval',
      consumedAmountMinorUnits: 7900,
      contributingRecordIds: [layer.ledgerRecord.id],
    });
    // Per-day sees only the trailing 24 hours, so the layer is gone from it.
    expect(rowsByKind(boots).per_day).toMatchObject({
      outcome: 'allow',
      consumedAmountMinorUnits: 0,
    });
    // The boots are pending now and hold the line; deny the request so the retry below is not "already requested".
    await world.ledger.updateRefundRecordStatus(boots.ledgerRecord.id, 'denied');

    world.clock.now += 31 * DAY;
    const bootsLater = await ask(world, 'order-1002', 'order-1002-line-1', 1, 'call-boots-later');
    expect(bootsLater.outcome).toBe('allow');
    expect(rowsByKind(bootsLater).per_customer).toMatchObject({ consumedAmountMinorUnits: 0 });
  });
});
