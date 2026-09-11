import type { IssueRefundResponse } from '../backend/types.js';
import { LedgerError, type RefundLedger } from './refund-ledger.js';
import type { RecordRefundParams, RefundLedgerRecord, RefundLedgerRecordStatus } from './types.js';

/**
 * The legal edges of the record lifecycle; the doc on
 * RefundLedgerRecord.status is the prose version. Settling reads the backend
 * response, so it only ever leaves `attempted`; every other edge is a human
 * decision through updateRefundRecordStatus.
 */
const TRANSITIONS: Record<RefundLedgerRecordStatus, readonly RefundLedgerRecordStatus[]> = {
  pending: ['attempted', 'denied'],
  attempted: ['ok', 'failed', 'unknown'],
  unknown: ['ok', 'failed'], // human reconciliation
  ok: [],
  failed: [],
  denied: [],
};

export class InMemoryRefundLedger implements RefundLedger {
  private records: RefundLedgerRecord[];
  private now: () => number;

  /**
   * `now` is injectable so tests, rolling-window caps and the simulator's
   * backdated corpus can control createdAt; production leaves the default.
   * Seeded records are copied in, and every exit copies out: the ledger's
   * state changes only through its own methods.
   */
  constructor(records?: RefundLedgerRecord[], now: () => number = Date.now) {
    this.records = records ? records.map((record) => ({ ...record })) : [];
    this.now = now;
  }

  private copyOut(record: RefundLedgerRecord): RefundLedgerRecord {
    return { ...record };
  }

  private indexOf(id: string): number {
    const index = this.records.findIndex((record) => record.id === id);
    if (index === -1) {
      throw new LedgerError('record_not_found', `Ledger record ${id} does not exist`);
    }
    return index;
  }

  async recordRefund(params: RecordRefundParams): Promise<RefundLedgerRecord> {
    const record: RefundLedgerRecord = {
      ...params,
      id: crypto.randomUUID(),
      createdAt: this.now(),
      status: params.requireApproval ? 'pending' : 'attempted',
    };

    this.records.push(record);

    return this.copyOut(record);
  }

  async settleRefundRecord(id: string, response: IssueRefundResponse): Promise<RefundLedgerRecord> {
    const index = this.indexOf(id);
    const record = this.records[index]!;

    if (record.status !== 'attempted') {
      throw new LedgerError(
        'illegal_transition',
        `Can only settle records in 'attempted' status; ${id} is '${record.status}'`,
      );
    }

    const settled: RefundLedgerRecord =
      response.status === 'ok'
        ? {
            ...record,
            status: 'ok',
            backendRefundId: response.refundId,
            refundedAmountMinorUnits: response.amountMinorUnits,
            refundedAmountCurrency: response.currency,
          }
        : { ...record, status: response.status };

    this.records[index] = settled;

    return this.copyOut(settled);
  }

  async updateRefundRecordStatus(
    id: string,
    status: RefundLedgerRecordStatus,
  ): Promise<RefundLedgerRecord> {
    const index = this.indexOf(id);
    const record = this.records[index]!;

    if (!TRANSITIONS[record.status].includes(status)) {
      throw new LedgerError(
        'illegal_transition',
        `Invalid status transition: ${record.status} -> ${status}`,
      );
    }

    const updated: RefundLedgerRecord = { ...record, status };

    this.records[index] = updated;

    return this.copyOut(updated);
  }

  async list(): Promise<RefundLedgerRecord[]> {
    return this.records.map((record) => this.copyOut(record));
  }
}
