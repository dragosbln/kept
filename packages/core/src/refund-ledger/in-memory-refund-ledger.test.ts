// Unit tests for the in-memory RefundLedger. Three contracts are pinned here:
// the record lifecycle (which edges exist, that settle only leaves
// `attempted`, that every illegal edge throws instead of silently passing);
// the read side of recordRefund (what a query returns: counting statuses,
// one currency, an inclusive window floor, each scope kind, results aligned
// with queries by index, and that the second of two calls in one tick sees
// the first); and the copy-out rule the conversation store also follows: the
// ledger's state changes only through its own methods.
//
// The lifecycle table below is written out by hand on purpose. Importing
// TRANSITIONS from the implementation would make the test tautological; this
// copy is the doc on RefundLedgerRecord.status, and the two must agree.

import { describe, expect, it } from 'vitest';
import { InMemoryRefundLedger } from './in-memory-refund-ledger.js';
import { LedgerError } from './refund-ledger.js';
import { customerKeyFor } from './customer-key.js';
import {
  COUNTING_STATUSES,
  type LedgerQuery,
  type LedgerScope,
  type RecordRefundParams,
  type RecordRefundResult,
  type RefundLedgerRecord,
  type RefundLedgerRecordStatus,
} from './types.js';
import type { IssueRefundResponse } from '../backend/types.js';
import type { DecisionOutcome, DecisionResult } from '../policy/types.js';

const ALL_STATUSES: readonly RefundLedgerRecordStatus[] = [
  'pending',
  'attempted',
  'denied',
  'ok',
  'failed',
  'unknown',
];

/** The lifecycle as documented on RefundLedgerRecord.status. */
const LEGAL_EDGES: Record<RefundLedgerRecordStatus, readonly RefundLedgerRecordStatus[]> = {
  pending: ['attempted', 'denied'],
  attempted: ['ok', 'failed', 'unknown'],
  unknown: ['ok', 'failed'],
  ok: [],
  failed: [],
  denied: [],
};

const FIXED_NOW = 1_787_184_000_000;

const SAM = customerKeyFor({ email: 'sam@example.com' });
const ANA = customerKeyFor({ email: 'ana@example.com' });

function refundParams(overrides: Partial<RecordRefundParams> = {}): RecordRefundParams {
  return {
    callId: 'call_1',
    orderId: 'order-1002',
    orderItemId: 'order-1002-line-1',
    quantity: 1,
    customerKey: SAM,
    conversationId: 'conv-1',
    promptHash: 'cafebabe',
    amountMinorUnits: 8900,
    currency: 'USD',
    ...overrides,
  };
}

/**
 * A decision with the given outcome and an empty caps record. The ledger
 * stores the decision and reads nothing past `outcome`, so these tests do
 * not need the engine.
 */
function decision(
  outcome: DecisionOutcome,
  params: RecordRefundParams = refundParams(),
): DecisionResult {
  const record = {
    configHash: 'cfg',
    request: {
      action: 'issue_refund' as const,
      customerKey: params.customerKey,
      orderId: params.orderId,
      orderItemId: params.orderItemId,
      quantity: params.quantity,
      currency: params.currency,
      amountMinorUnits: params.amountMinorUnits,
    },
    eligibility: [],
    perCap: [],
  };
  switch (outcome) {
    case 'allow':
      return { outcome, record };
    case 'require_approval':
      return { outcome, reason: 'cap_exceeded', record };
    case 'deny':
      return { outcome, reason: 'not_eligible', record };
  }
}

/** Records with a fixed outcome and no queries; the lifecycle tests do not care about the decision. */
async function recordAs(
  ledger: InMemoryRefundLedger,
  outcome: 'allow' | 'require_approval',
  params: RecordRefundParams = refundParams(),
): Promise<RefundLedgerRecord> {
  return written(await ledger.recordRefund(params, [], () => decision(outcome, params)))
    .ledgerRecord;
}

/** Narrows to the written variants of the result; a deny here is a test bug. */
function written(
  result: RecordRefundResult,
): Extract<RecordRefundResult, { ledgerRecord: RefundLedgerRecord }> {
  if (result.outcome === 'deny') throw new Error('expected a written record, got deny');
  return result;
}

const okResponse: IssueRefundResponse = {
  status: 'ok',
  refundId: 'backend-refund-1',
  amountMinorUnits: 8900,
  currency: 'USD',
};

/** One backend answer per settled status. */
const BACKEND_RESPONSES: Record<'ok' | 'failed' | 'unknown', IssueRefundResponse> = {
  ok: okResponse,
  failed: { status: 'failed', errorType: 'quantity_exceeds_unrefunded' },
  unknown: { status: 'unknown' },
};

/** Adds one record to `ledger` and drives it to `status` through legal edges only. */
async function addRecordIn(
  ledger: InMemoryRefundLedger,
  status: RefundLedgerRecordStatus,
  params: RecordRefundParams = refundParams(),
): Promise<string> {
  switch (status) {
    case 'pending':
      return (await recordAs(ledger, 'require_approval', params)).id;
    case 'attempted':
      return (await recordAs(ledger, 'allow', params)).id;
    case 'denied': {
      const { id } = await recordAs(ledger, 'require_approval', params);
      await ledger.updateRefundRecordStatus(id, 'denied');
      return id;
    }
    case 'ok':
    case 'failed':
    case 'unknown': {
      const { id } = await recordAs(ledger, 'allow', params);
      await ledger.settleRefundRecord(id, BACKEND_RESPONSES[status]);
      return id;
    }
  }
}

/** A fresh ledger holding one record driven to `status` through legal edges only. */
async function ledgerWithRecordIn(
  status: RefundLedgerRecordStatus,
): Promise<{ ledger: InMemoryRefundLedger; id: string }> {
  const ledger = new InMemoryRefundLedger([], () => FIXED_NOW);
  const id = await addRecordIn(ledger, status);
  return { ledger, id };
}

/** What decide was handed for `queries`; the decision is a deny, so nothing is written. */
async function snapshotFor(
  ledger: InMemoryRefundLedger,
  queries: LedgerQuery[],
): Promise<RefundLedgerRecord[][]> {
  let seen: RefundLedgerRecord[][] = [];
  await ledger.recordRefund(refundParams(), queries, (results) => {
    seen = results;
    return decision('deny');
  });
  return seen;
}

function usd(scope: LedgerScope, sinceMs?: number): LedgerQuery {
  return { scope, currency: 'USD', ...(sinceMs === undefined ? {} : { sinceMs }) };
}

const ids = (records: RefundLedgerRecord[]): string[] => records.map((record) => record.id);

describe('InMemoryRefundLedger', () => {
  describe('recordRefund: the write', () => {
    it('opens the record as attempted on allow and stores the decision on it', async () => {
      const ledger = new InMemoryRefundLedger([], () => FIXED_NOW);
      const result = written(
        await ledger.recordRefund(refundParams(), [], () => decision('allow')),
      );
      expect(result.outcome).toBe('allow');
      expect(result.ledgerRecord).toMatchObject({
        ...refundParams(),
        status: 'attempted',
        createdAt: FIXED_NOW,
        decisionRecord: decision('allow'),
      });
      expect(result.ledgerRecord.id).toEqual(expect.any(String));
      expect(result.ledgerRecord).not.toHaveProperty('backendRefundId');
    });

    it('opens the record as pending on require_approval', async () => {
      const ledger = new InMemoryRefundLedger();
      const record = await recordAs(ledger, 'require_approval');
      expect(record.status).toBe('pending');
    });

    it('writes nothing on deny and returns only the decision', async () => {
      const ledger = new InMemoryRefundLedger();
      const result = await ledger.recordRefund(refundParams(), [], () => decision('deny'));
      expect(result).toMatchObject({ outcome: 'deny', reason: 'not_eligible' });
      expect(result).not.toHaveProperty('ledgerRecord');
      expect(await ledger.list()).toEqual([]);
    });

    it('writes nothing when decide throws, and the throw propagates', async () => {
      const ledger = new InMemoryRefundLedger();
      await expect(
        ledger.recordRefund(refundParams(), [], () => {
          throw new Error('caller bug');
        }),
      ).rejects.toThrow('caller bug');
      expect(await ledger.list()).toEqual([]);
    });

    it('gives every record its own id', async () => {
      const ledger = new InMemoryRefundLedger();
      const first = await recordAs(ledger, 'allow');
      const second = await recordAs(ledger, 'allow');
      expect(second.id).not.toBe(first.id);
    });
  });

  describe('recordRefund: the read', () => {
    it('hands decide one result list per query, aligned by index', async () => {
      const ledger = new InMemoryRefundLedger();
      const a = await recordAs(ledger, 'allow', refundParams({ orderId: 'order-A' }));
      const b = await recordAs(ledger, 'allow', refundParams({ orderId: 'order-B' }));

      const results = await snapshotFor(ledger, [
        usd({ kind: 'orderId', value: 'order-A' }),
        usd({ kind: 'none' }),
        usd({ kind: 'orderId', value: 'order-B' }),
      ]);

      expect(results.map(ids)).toEqual([[a.id], [], [b.id]]);
    });

    it('hands decide only counting records', async () => {
      const ledger = new InMemoryRefundLedger();
      await Promise.all(
        ALL_STATUSES.map((status) =>
          addRecordIn(ledger, status, refundParams({ callId: `call-${status}` })),
        ),
      );

      const [all] = await snapshotFor(ledger, [usd({ kind: 'all' })]);

      expect(new Set(all!.map((record) => record.status))).toEqual(COUNTING_STATUSES);
      expect(all).toHaveLength(COUNTING_STATUSES.size);
    });

    it('partitions by the query currency', async () => {
      const ledger = new InMemoryRefundLedger();
      const inUsd = await recordAs(ledger, 'allow');
      await recordAs(ledger, 'allow', refundParams({ orderId: 'order-1004', currency: 'EUR' }));

      const [all] = await snapshotFor(ledger, [usd({ kind: 'all' })]);

      expect(ids(all!)).toEqual([inUsd.id]);
    });

    it('applies the window floor inclusively', async () => {
      const ledger = new InMemoryRefundLedger([], () => FIXED_NOW);
      const record = await recordAs(ledger, 'allow');

      const [atFloor] = await snapshotFor(ledger, [usd({ kind: 'all' }, FIXED_NOW)]);
      const [pastFloor] = await snapshotFor(ledger, [usd({ kind: 'all' }, FIXED_NOW + 1)]);

      expect(ids(atFloor!)).toEqual([record.id]);
      expect(pastFloor).toEqual([]);
    });

    it('matches each scope kind', async () => {
      const ledger = new InMemoryRefundLedger();
      const bootsA = await recordAs(ledger, 'allow', refundParams({ callId: 'c1' }));
      const insoles = await recordAs(
        ledger,
        'allow',
        refundParams({ callId: 'c2', orderItemId: 'order-1002-line-2', amountMinorUnits: 1200 }),
      );
      const layer = await recordAs(
        ledger,
        'allow',
        refundParams({
          callId: 'c3',
          orderId: 'order-1005',
          orderItemId: 'order-1005-line-1',
          amountMinorUnits: 7900,
        }),
      );
      const other = await recordAs(
        ledger,
        'allow',
        refundParams({
          callId: 'c4',
          orderId: 'order-1006',
          orderItemId: 'order-1006-line-1',
          customerKey: ANA,
        }),
      );

      const results = await snapshotFor(ledger, [
        usd({ kind: 'none' }),
        usd({ kind: 'all' }),
        usd({ kind: 'customerKey', value: SAM }),
        usd({ kind: 'orderId', value: 'order-1002' }),
        usd({ kind: 'orderLine', orderId: 'order-1002', orderItemId: 'order-1002-line-1' }),
      ]);

      expect(results.map(ids)).toEqual([
        [],
        [bootsA.id, insoles.id, layer.id, other.id],
        [bootsA.id, insoles.id, layer.id],
        [bootsA.id, insoles.id],
        [bootsA.id],
      ]);
    });

    it('the second of two calls made in the same tick sees the first', async () => {
      // Two tool calls in one round run under Promise.all without an await
      // between them. Read, decide and write must be one step, or both would
      // decide on the empty snapshot.
      const ledger = new InMemoryRefundLedger();
      const seen: number[] = [];
      const call = (callId: string): Promise<RecordRefundResult> =>
        ledger.recordRefund(refundParams({ callId }), [usd({ kind: 'all' })], (results) => {
          seen.push(results[0]!.length);
          return decision('allow');
        });

      await Promise.all([call('first'), call('second')]);

      expect(seen).toEqual([0, 1]);
      expect(await ledger.list()).toHaveLength(2);
    });

    it('hands decide copies: mutating a result does not change the ledger', async () => {
      const ledger = new InMemoryRefundLedger();
      await recordAs(ledger, 'allow');
      await ledger.recordRefund(refundParams(), [usd({ kind: 'all' })], (results) => {
        results[0]![0]!.status = 'denied';
        results[0]![0]!.amountMinorUnits = 0;
        return decision('deny');
      });
      expect((await ledger.list())[0]).toMatchObject({
        status: 'attempted',
        amountMinorUnits: 8900,
      });
    });
  });

  describe('settleRefundRecord', () => {
    it('ok records the backend refund id and the amount actually moved', async () => {
      const { ledger, id } = await ledgerWithRecordIn('attempted');
      const settled = await ledger.settleRefundRecord(id, okResponse);
      expect(settled).toMatchObject({
        status: 'ok',
        backendRefundId: 'backend-refund-1',
        refundedAmountMinorUnits: 8900,
        refundedAmountCurrency: 'USD',
      });
      // The expected amount recorded before the call is kept beside it.
      expect(settled.amountMinorUnits).toBe(8900);
    });

    it.each(['failed', 'unknown'] as const)(
      '%s carries only the status, no backend fields',
      async (status) => {
        const { ledger, id } = await ledgerWithRecordIn('attempted');
        const settled = await ledger.settleRefundRecord(id, BACKEND_RESPONSES[status]);
        expect(settled.status).toBe(status);
        expect(settled).not.toHaveProperty('backendRefundId');
        expect(settled).not.toHaveProperty('refundedAmountMinorUnits');
      },
    );

    it('persists the settlement: a later list sees it', async () => {
      const { ledger, id } = await ledgerWithRecordIn('attempted');
      await ledger.settleRefundRecord(id, { status: 'unknown' });
      expect((await ledger.list()).map((record) => record.status)).toEqual(['unknown']);
    });

    it.each(ALL_STATUSES.filter((candidate) => candidate !== 'attempted'))(
      'refuses to settle a record in %s',
      async (status) => {
        const { ledger, id } = await ledgerWithRecordIn(status);
        await expect(ledger.settleRefundRecord(id, okResponse)).rejects.toThrow(LedgerError);
      },
    );

    it('throws on an unknown id', async () => {
      const ledger = new InMemoryRefundLedger();
      await expect(ledger.settleRefundRecord('no-such-id', okResponse)).rejects.toMatchObject({
        name: 'LedgerError',
        errorType: 'record_not_found',
      });
    });

    it('names an illegal edge as such', async () => {
      const { ledger, id } = await ledgerWithRecordIn('ok');
      await expect(ledger.settleRefundRecord(id, okResponse)).rejects.toMatchObject({
        name: 'LedgerError',
        errorType: 'illegal_transition',
      });
    });
  });

  describe('updateRefundRecordStatus', () => {
    // Every (from, to) pair, so a new status or a loosened edge in the
    // implementation fails here rather than passing silently.
    for (const from of ALL_STATUSES) {
      for (const to of ALL_STATUSES) {
        const legal = LEGAL_EDGES[from].includes(to);
        it(`${from} -> ${to} is ${legal ? 'allowed' : 'rejected'}`, async () => {
          const { ledger, id } = await ledgerWithRecordIn(from);
          if (legal) {
            const updated = await ledger.updateRefundRecordStatus(id, to);
            expect(updated.status).toBe(to);
            expect((await ledger.list())[0]!.status).toBe(to);
          } else {
            await expect(ledger.updateRefundRecordStatus(id, to)).rejects.toThrow(LedgerError);
            expect((await ledger.list())[0]!.status, 'unchanged after a rejected edge').toBe(from);
          }
        });
      }
    }

    it('throws on an unknown id', async () => {
      const ledger = new InMemoryRefundLedger();
      await expect(ledger.updateRefundRecordStatus('no-such-id', 'denied')).rejects.toThrow(
        LedgerError,
      );
    });
  });

  describe('list', () => {
    it('returns every record in insertion order', async () => {
      const ledger = new InMemoryRefundLedger();
      const first = await recordAs(ledger, 'allow', refundParams({ callId: 'call_1' }));
      const second = await recordAs(ledger, 'allow', refundParams({ callId: 'call_2' }));
      const third = await recordAs(ledger, 'allow', refundParams({ callId: 'call_3' }));
      expect((await ledger.list()).map((record) => record.id)).toEqual([
        first.id,
        second.id,
        third.id,
      ]);
    });

    it('is empty for a fresh ledger', async () => {
      expect(await new InMemoryRefundLedger().list()).toEqual([]);
    });
  });

  describe('copy-out', () => {
    it('mutating a returned record does not change the ledger', async () => {
      const ledger = new InMemoryRefundLedger();
      const record = await recordAs(ledger, 'allow');
      record.status = 'ok';
      record.amountMinorUnits = 0;
      expect((await ledger.list())[0]).toMatchObject({
        status: 'attempted',
        amountMinorUnits: 8900,
      });
    });

    it('mutating a listed array or its elements does not change the ledger', async () => {
      const ledger = new InMemoryRefundLedger();
      await recordAs(ledger, 'allow');
      const listed = await ledger.list();
      listed[0]!.status = 'denied';
      listed.length = 0;
      expect((await ledger.list()).map((record) => record.status)).toEqual(['attempted']);
    });

    it('copies the seed in', async () => {
      const { ledger, id } = await ledgerWithRecordIn('attempted');
      const seed = await ledger.list();
      const reseeded = new InMemoryRefundLedger(seed);
      seed[0]!.status = 'ok';
      expect((await reseeded.list())[0]).toMatchObject({ id, status: 'attempted' });
    });
  });
});
