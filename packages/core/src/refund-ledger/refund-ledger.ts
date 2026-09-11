// The refund ledger: Kept's own record of every refund decision, written
// before the commerce backend is asked to move money. The backend answers
// "did the money move"; the ledger answers "what did we decide, when, in
// which conversation, under which prompt, and what came back". Caps, the
// approval inbox and the audit trail all read from here, never from the
// backend.
//
// Invariants:
// - Write-ahead: a record exists (`pending` or `attempted`) before
//   OrderBackend.issueRefund is called. A crash between the two leaves an
//   `attempted` record with no backend fields, which is exactly the
//   `unknown` situation and is reconciled the same way.
// - The lifecycle is the one documented on RefundLedgerRecord.status; settle
//   and update enforce it and throw on an illegal edge.
// - Throws only LedgerError, and only on caller bugs (unknown id, illegal
//   transition). A caller that has already called the backend must turn any
//   throw at that point into `unknown`, never `failed`: the money may have
//   moved.

import type { IssueRefundResponse } from '../backend/types.js';
import type { RecordRefundParams, RefundLedgerRecord, RefundLedgerRecordStatus } from './types.js';

/** Why a ledger call was refused. Low-cardinality, like every errorType in the codebase. */
export type LedgerErrorType = 'record_not_found' | 'illegal_transition';

/**
 * The only error a RefundLedger throws, whatever the implementation, so a
 * caller can tell a ledger refusal from anything else with instanceof. Both
 * kinds are caller bugs; the module header says what a caller must do with
 * one once the backend has been called.
 */
export class LedgerError extends Error {
  readonly errorType: LedgerErrorType;

  constructor(errorType: LedgerErrorType, message: string) {
    super(message);
    this.name = 'LedgerError';
    this.errorType = errorType;
  }
}

export interface RefundLedger {
  /**
   * Opens a record: `pending` when approval is required, `attempted` otherwise.
   *
   * TODO: the loop can run tool uses in parallel, so the policy check and the ledger need to be one operation
   */
  recordRefund(params: RecordRefundParams): Promise<RefundLedgerRecord>;
  /**
   * Closes an `attempted` record with what the backend answered. `ok` carries
   * the backend's refund id and the amount it actually moved; `failed` and
   * `unknown` carry only the status.
   */
  settleRefundRecord(id: string, response: IssueRefundResponse): Promise<RefundLedgerRecord>;
  /**
   * The human edges: approve or deny a `pending` record, reconcile an
   * `unknown` one. Guarded by the same transition table as settle.
   */
  updateRefundRecordStatus(
    id: string,
    status: RefundLedgerRecordStatus,
  ): Promise<RefundLedgerRecord>;
  /**
   * Every record, in insertion order. The audit views and the attack driver
   * read it; the policy engine will query by order and by customer once caps
   * land.
   */
  list(): Promise<RefundLedgerRecord[]>;
}
