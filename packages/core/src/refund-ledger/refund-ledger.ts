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
// - Read, decide, write are one operation (recordRefund): two requests in
//   the same tool round cannot both pass on the same snapshot.
// - The lifecycle is the one documented on RefundLedgerRecord.status; settle
//   and update enforce it and throw on an illegal edge.
// - Throws only LedgerError, and only on caller bugs (unknown id, illegal
//   transition). A caller that has already called the backend must turn any
//   throw at that point into `unknown`, never `failed`: the money may have
//   moved.

import type { IssueRefundResponse } from '../backend/types.js';
import type { DecisionResult } from '../policy/types.js';
import type {
  LedgerQuery,
  RecordRefundParams,
  RecordRefundResult,
  RefundLedgerRecord,
  RefundLedgerRecordStatus,
} from './types.js';

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

/**
 * The decision callback recordRefund runs between its read and its write.
 * Synchronous by signature: the in-memory ledger's atomicity is exactly
 * "no await between the three", and an async decide would break it without
 * a compile error anywhere else.
 */
export type DecideFn = (results: RefundLedgerRecord[][]) => DecisionResult;

export interface RefundLedger {
  /**
   * The atomic operation behind every write. Reads the counting records each
   * query asks for, hands the result lists to `decide` aligned by index, and
   * opens a record on allow (`attempted`) or require_approval (`pending`).
   * Deny writes nothing and returns only the decision. A throw from `decide`
   * propagates before anything is written.
   *
   * A database implementation runs the three steps in one transaction under a
   * lock; the per_day scope reads every record, so that lock is effectively
   * global, which is fine at support-desk write rates.
   */
  recordRefund(
    params: RecordRefundParams,
    queries: LedgerQuery[],
    decide: DecideFn,
  ): Promise<RecordRefundResult>;
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
   * read it; the policy engine reads through recordRefund's queries instead.
   */
  list(): Promise<RefundLedgerRecord[]>;
}
