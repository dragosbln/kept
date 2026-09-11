// Unit tests for the in-memory RefundLedger. Two contracts are pinned here:
// the record lifecycle (which edges exist, that settle only leaves
// `attempted`, that every illegal edge throws instead of silently passing)
// and the copy-out rule the conversation store also follows: the ledger's
// state changes only through its own methods.
//
// The lifecycle table below is written out by hand on purpose. Importing
// TRANSITIONS from the implementation would make the test tautological; this
// copy is the doc on RefundLedgerRecord.status, and the two must agree.

import { describe, expect, it } from 'vitest';
import { InMemoryRefundLedger } from './in-memory-refund-ledger.js';
import { LedgerError } from './refund-ledger.js';
import { customerKeyFor } from './customer-key.js';
import type { RecordRefundParams, RefundLedgerRecordStatus } from './types.js';
import type { IssueRefundResponse } from '../backend/types.js';

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

function refundParams(overrides: Partial<RecordRefundParams> = {}): RecordRefundParams {
  return {
    callId: 'call_1',
    orderId: 'order-1002',
    orderItemId: 'order-1002-line-1',
    quantity: 1,
    customerKey: customerKeyFor({ email: 'sam@example.com' }),
    conversationId: 'conv-1',
    promptHash: 'cafebabe',
    amountMinorUnits: 8900,
    currency: 'USD',
    requireApproval: false,
    ...overrides,
  };
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

/** A fresh ledger holding one record driven to `status` through legal edges only. */
async function ledgerWithRecordIn(
  status: RefundLedgerRecordStatus,
): Promise<{ ledger: InMemoryRefundLedger; id: string }> {
  const ledger = new InMemoryRefundLedger([], () => FIXED_NOW);
  switch (status) {
    case 'pending': {
      const { id } = await ledger.recordRefund(refundParams({ requireApproval: true }));
      return { ledger, id };
    }
    case 'attempted': {
      const { id } = await ledger.recordRefund(refundParams());
      return { ledger, id };
    }
    case 'denied': {
      const { id } = await ledger.recordRefund(refundParams({ requireApproval: true }));
      await ledger.updateRefundRecordStatus(id, 'denied');
      return { ledger, id };
    }
    case 'ok':
    case 'failed':
    case 'unknown': {
      const { id } = await ledger.recordRefund(refundParams());
      await ledger.settleRefundRecord(id, BACKEND_RESPONSES[status]);
      return { ledger, id };
    }
  }
}

describe('InMemoryRefundLedger', () => {
  describe('recordRefund', () => {
    it('opens the record as attempted when no approval is required', async () => {
      const ledger = new InMemoryRefundLedger([], () => FIXED_NOW);
      const record = await ledger.recordRefund(refundParams());
      expect(record).toMatchObject({
        ...refundParams(),
        status: 'attempted',
        createdAt: FIXED_NOW,
      });
      expect(record.id).toEqual(expect.any(String));
      expect(record).not.toHaveProperty('backendRefundId');
    });

    it('opens the record as pending when approval is required', async () => {
      const ledger = new InMemoryRefundLedger();
      const record = await ledger.recordRefund(refundParams({ requireApproval: true }));
      expect(record.status).toBe('pending');
    });

    it('gives every record its own id', async () => {
      const ledger = new InMemoryRefundLedger();
      const first = await ledger.recordRefund(refundParams());
      const second = await ledger.recordRefund(refundParams());
      expect(second.id).not.toBe(first.id);
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
      const first = await ledger.recordRefund(refundParams({ callId: 'call_1' }));
      const second = await ledger.recordRefund(refundParams({ callId: 'call_2' }));
      const third = await ledger.recordRefund(refundParams({ callId: 'call_3' }));
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
      const record = await ledger.recordRefund(refundParams());
      record.status = 'ok';
      record.amountMinorUnits = 0;
      expect((await ledger.list())[0]).toMatchObject({
        status: 'attempted',
        amountMinorUnits: 8900,
      });
    });

    it('mutating a listed array or its elements does not change the ledger', async () => {
      const ledger = new InMemoryRefundLedger();
      await ledger.recordRefund(refundParams());
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
