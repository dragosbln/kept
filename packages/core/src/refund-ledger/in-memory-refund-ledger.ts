import type { IssueRefundResponse } from '../backend/types.js';
import { LedgerError, type DecideFn, type RefundLedger } from './refund-ledger.js';
import {
  COUNTING_STATUSES,
  type LedgerQuery,
  type LedgerScope,
  type RecordRefundParams,
  type RecordRefundResult,
  type RefundLedgerRecord,
  type RefundLedgerRecordStatus,
} from './types.js';

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

/**
 * Does one record fall inside a scope? One switch, exhaustive: a new scope
 * kind fails to compile here until it is matched. `none` answers false for
 * every record, so a per_call query yields [] through the same path as the
 * others and results stay aligned with queries by index.
 */
function matchesScope(record: RefundLedgerRecord, scope: LedgerScope): boolean {
  switch (scope.kind) {
    case 'none':
      return false;
    case 'all':
      return true;
    case 'customerKey':
      return record.customerKey === scope.value;
    case 'orderId':
      return record.orderId === scope.value;
    case 'orderLine':
      return record.orderId === scope.orderId && record.orderItemId === scope.orderItemId;
    default:
      scope satisfies never;
      return false;
  }
}

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

  /**
   * One result list per query, aligned by index. The predicate is the whole
   * "what counts" rule, applied once here and nowhere else: counting
   * statuses, the query's currency, the inclusive window floor, the scope.
   * Synchronous on purpose: recordRefund relies on there being no await
   * between this read and its write.
   */
  private selectRecords(queries: LedgerQuery[]): RefundLedgerRecord[][] {
    return queries.map((query) =>
      this.records
        .filter(
          (record) =>
            COUNTING_STATUSES.has(record.status) &&
            record.currency === query.currency &&
            (query.sinceMs === undefined || record.createdAt >= query.sinceMs) &&
            matchesScope(record, query.scope),
        )
        .map((record) => this.copyOut(record)),
    );
  }

  async recordRefund(
    params: RecordRefundParams,
    queries: LedgerQuery[],
    decide: DecideFn,
  ): Promise<RecordRefundResult> {
    // No await between the read, the decision and the write: the call runs
    // to completion on the tick it was made, so a second call in the same
    // tool round starts on a snapshot that already holds this record. The
    // concurrency test in the suite is the guard against an await creeping
    // in here.
    const results = this.selectRecords(queries);
    const decision = decide(results);

    // Deny writes nothing: no refund was decided, so there is nothing to
    // reserve and nothing for the inbox. The decision span is deny's only
    // trace until the audit log lands.
    if (decision.outcome === 'deny') {
      return decision;
    }

    const id = crypto.randomUUID();
    const record: RefundLedgerRecord = {
      ...params,
      id,
      idempotencyKey: id,
      createdAt: this.now(),
      status: decision.outcome === 'allow' ? 'attempted' : 'pending',
      decisionRecord: decision,
    };

    this.records.push(record);

    // Spread distributes over the decision union, so each member keeps its
    // own outcome and reason and gains the row.
    return { ...decision, ledgerRecord: this.copyOut(record) };
  }

  async findRecord(id: string): Promise<RefundLedgerRecord | null> {
    const record = this.records.find((candidate) => candidate.id === id);
    return record ? this.copyOut(record) : null;
  }

  async settleRefundRecord(id: string, response: IssueRefundResponse): Promise<RefundLedgerRecord> {
    const index = this.indexOf(id);
    const record = this.records[index]!;

    if (record.status !== 'attempted' && record.status !== 'unknown') {
      throw new LedgerError(
        'illegal_transition',
        `Can only settle records in 'attempted' or 'unknown' status; ${id} is '${record.status}'`,
      );
    }

    // Reconciliation came back unknown again: nothing new to record.
    if (record.status === 'unknown' && response.status === 'unknown') {
      return this.copyOut(record);
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
