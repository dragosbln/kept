// Reconciliation against the demo backend's idempotency contract, with the
// three ways a refund ends up needing it:
// - moved but answered unknown: the backend executed, the answer was lost;
//   the replay returns the recorded ok and nothing moves twice;
// - never received: the request never reached the backend; the replay
//   executes it for the first time;
// - crashed between the record and the backend call: the crash signature,
//   an attempted record older than the tool window; the replay executes it.
// Plus the guards: a young attempted record is in flight, a settled record
// is not reconcilable, an unknown id is skipped, and an unknown answer on
// reconciliation leaves the record unknown.

import { describe, expect, it } from 'vitest';
import { DemoBackend } from '../backend/demo.js';
import type { OrderBackend } from '../backend/order-backend.js';
import { makeDemoOrders, DEMO_SEED_EPOCH } from '../backend/seed-orders.js';
import { customerKeyFor } from '../refund-ledger/customer-key.js';
import { InMemoryRefundLedger } from '../refund-ledger/in-memory-refund-ledger.js';
import type { RecordRefundParams, RefundLedgerRecord } from '../refund-ledger/types.js';
import type { DecisionResult } from '../policy/types.js';
import { executeRefund } from './execute.js';
import { reconcileRefund, type ReconcileResult } from './reconcile.js';

const NOW = DEMO_SEED_EPOCH;
const WINDOW_MS = 10_000;

/** order-1005 line 1: one Merino Base Layer at $79.00, delivered. */
const params: RecordRefundParams = {
  callId: 'call-1',
  orderId: 'order-1005',
  orderItemId: 'order-1005-line-1',
  quantity: 1,
  customerKey: customerKeyFor({ email: 'sam@example.com' }),
  conversationId: 'conv-1',
  promptHash: 'hash-1',
  amountMinorUnits: 7900,
  currency: 'USD',
};

const allow: DecisionResult = {
  outcome: 'allow',
  record: {
    configHash: 'cfg',
    request: {
      action: 'issue_refund',
      customerKey: params.customerKey,
      orderId: params.orderId,
      orderItemId: params.orderItemId,
      quantity: params.quantity,
      currency: params.currency,
      amountMinorUnits: params.amountMinorUnits,
    },
    eligibility: [],
    perCap: [],
  },
};

type World = { clock: { now: number }; ledger: InMemoryRefundLedger; demo: DemoBackend };

function setup(): World {
  const clock = { now: NOW };
  return {
    clock,
    ledger: new InMemoryRefundLedger([], () => clock.now),
    demo: new DemoBackend(makeDemoOrders(NOW)),
  };
}

/** An allow decision recorded: the write-ahead `attempted` row, as the tool leaves it before the backend call. */
async function attemptedRecord(world: World): Promise<RefundLedgerRecord> {
  const result = await world.ledger.recordRefund(params, [], () => allow);
  if (result.outcome === 'deny') throw new Error('test bug: allow expected');
  return result.ledgerRecord;
}

/** The backend executed and the answer was lost on the way back. */
function movedButUnknown(demo: DemoBackend): OrderBackend {
  return {
    findOrder: (id) => demo.findOrder(id),
    issueRefund: async (key, request) => {
      await demo.issueRefund(key, request);
      return { status: 'unknown', errorType: 'platform_unreachable' };
    },
  };
}

/** The request never reached the backend. */
function neverReceived(demo: DemoBackend): OrderBackend {
  return {
    findOrder: (id) => demo.findOrder(id),
    issueRefund: async () => ({ status: 'unknown', errorType: 'platform_unreachable' }),
  };
}

const reconcile = (
  world: World,
  id: string,
  backend: OrderBackend = world.demo,
): Promise<ReconcileResult> =>
  reconcileRefund(id, world.ledger, backend, { now: world.clock.now, windowMs: WINDOW_MS });

describe('reconcileRefund', () => {
  it('moved but answered unknown: the replay returns the recorded ok and moves nothing twice', async () => {
    const world = setup();
    const record = await attemptedRecord(world);

    const first = await executeRefund(record, world.ledger, movedButUnknown(world.demo));
    expect(first).toMatchObject({ status: 'settled', ledgerRecord: { status: 'unknown' } });

    const result = await reconcile(world, record.id);

    expect(result).toMatchObject({
      status: 'settled',
      backendResponse: { status: 'ok', amountMinorUnits: 7900 },
      ledgerRecord: {
        status: 'ok',
        refundedAmountMinorUnits: 7900,
        backendRefundId: expect.any(String),
      },
    });
    // Nothing moved twice: the only unit on the line was consumed once.
    expect(
      await world.demo.issueRefund('probe', {
        orderId: 'order-1005',
        orderItemId: 'order-1005-line-1',
        quantity: 1,
      }),
    ).toEqual({ status: 'failed', errorType: 'quantity_exceeds_unrefunded' });
  });

  it('never received: the replay executes the request for the first time', async () => {
    const world = setup();
    const record = await attemptedRecord(world);
    await executeRefund(record, world.ledger, neverReceived(world.demo));
    expect((await world.ledger.list())[0]!.status).toBe('unknown');

    const result = await reconcile(world, record.id);

    expect(result).toMatchObject({ status: 'settled', ledgerRecord: { status: 'ok' } });
  });

  it('crash signature: an attempted record older than the window is executed; a younger one is in flight', async () => {
    const world = setup();
    const record = await attemptedRecord(world); // recorded, backend never called

    expect(await reconcile(world, record.id)).toEqual({
      status: 'skipped',
      reason: 'in_flight',
      ledgerStatus: 'attempted',
    });

    world.clock.now += WINDOW_MS + 1;
    const result = await reconcile(world, record.id);

    expect(result).toMatchObject({ status: 'settled', ledgerRecord: { status: 'ok' } });
  });

  it('an unknown answer on reconciliation leaves the record unknown, ready for another attempt', async () => {
    const world = setup();
    const record = await attemptedRecord(world);
    await executeRefund(record, world.ledger, neverReceived(world.demo));

    const result = await reconcile(world, record.id, neverReceived(world.demo));

    expect(result).toMatchObject({ status: 'settled', ledgerRecord: { status: 'unknown' } });
    expect((await world.ledger.list())[0]!.status).toBe('unknown');
  });

  it('skips settled records and unknown ids', async () => {
    const world = setup();
    const record = await attemptedRecord(world);
    await executeRefund(record, world.ledger, world.demo);

    expect(await reconcile(world, record.id)).toEqual({
      status: 'skipped',
      reason: 'not_reconcilable',
      ledgerStatus: 'ok',
    });
    expect(await reconcile(world, 'no-such-id')).toEqual({
      status: 'skipped',
      reason: 'record_not_found',
    });
  });

  it('a throw while replaying an unknown record leaves it unknown and reports the error', async () => {
    const world = setup();
    const record = await attemptedRecord(world);
    await executeRefund(record, world.ledger, neverReceived(world.demo));
    const throwing: OrderBackend = {
      findOrder: (id) => world.demo.findOrder(id),
      issueRefund: async () => {
        throw new Error('platform down');
      },
    };

    const result = await reconcile(world, record.id, throwing);

    expect(result).toMatchObject({
      status: 'unknown',
      error: { errorMessage: 'platform down' },
      ledgerRecord: { status: 'unknown' },
    });
    expect(result).not.toHaveProperty('reconciliationError');
  });
});
