// The refund write path from the ledger record onward, shared by the tool
// and by the inbox's approve and reconcile actions: ask the backend, settle
// the record with its answer. Position decides the state: before the
// backend call nothing has moved; after it, any throw, ledger or otherwise,
// is unknown.

import type { OrderBackend } from '../backend/order-backend.js';
import type { IssueRefundResponse } from '../backend/types.js';
import type { RefundLedger } from '../refund-ledger/refund-ledger.js';
import type { RefundLedgerRecord, RefundLedgerRecordStatus } from '../refund-ledger/types.js';

export type ErrorDetail = { errorName?: string; errorMessage: string };

/**
 * A thrown value as the trace records it: name and message. The object
 * itself serializes to nothing useful.
 */
export function describeError(error: unknown): ErrorDetail {
  return error instanceof Error
    ? { errorName: error.name, errorMessage: error.message }
    : { errorMessage: String(error) };
}

/**
 * What executing a record against the backend came to, named by what is
 * known afterwards, never by what threw. `settled`: the backend answered and
 * the ledger holds the answer. `unknown`: something threw after the backend
 * was asked, so the money may have moved; `ledgerRecord` is the row marked
 * unknown when the ledger could be told, null with the refusal beside it
 * when it could not, and `backendResponse` is whatever answer had arrived
 * before the throw. `not_attempted`: the record was in no state to execute,
 * nothing was asked.
 */
export type RefundExecution =
  | { status: 'not_attempted'; ledgerStatus: RefundLedgerRecordStatus }
  | { status: 'settled'; backendResponse: IssueRefundResponse; ledgerRecord: RefundLedgerRecord }
  | {
      status: 'unknown';
      error: ErrorDetail;
      backendResponse: IssueRefundResponse | null;
      ledgerRecord: RefundLedgerRecord | null;
      reconciliationError?: ErrorDetail;
    };

/**
 * Executes an `attempted` record, or replays an `unknown` one with the same
 * key. The reconciliation in the catch is itself guarded, because a throw
 * escaping here would reach the executor as failed, which tells the model
 * it is safe to try again. A record already unknown is left as it is on a
 * throw: the ledger already says what the tool knows.
 */
export async function executeRefund(
  ledgerRecord: RefundLedgerRecord,
  ledger: RefundLedger,
  backend: OrderBackend,
): Promise<RefundExecution> {
  if (ledgerRecord.status !== 'attempted' && ledgerRecord.status !== 'unknown') {
    return { status: 'not_attempted', ledgerStatus: ledgerRecord.status };
  }

  let backendResponse: IssueRefundResponse | null = null;
  try {
    backendResponse = await backend.issueRefund(ledgerRecord.idempotencyKey, {
      orderId: ledgerRecord.orderId,
      orderItemId: ledgerRecord.orderItemId,
      quantity: ledgerRecord.quantity,
    });
    const settled = await ledger.settleRefundRecord(ledgerRecord.id, backendResponse);
    return { status: 'settled', backendResponse, ledgerRecord: settled };
  } catch (error) {
    if (ledgerRecord.status === 'unknown') {
      return { status: 'unknown', error: describeError(error), backendResponse, ledgerRecord };
    }
    try {
      const reconciled = await ledger.updateRefundRecordStatus(ledgerRecord.id, 'unknown');
      return {
        status: 'unknown',
        error: describeError(error),
        backendResponse,
        ledgerRecord: reconciled,
      };
    } catch (reconciliationError) {
      return {
        status: 'unknown',
        error: describeError(error),
        backendResponse,
        ledgerRecord: null,
        reconciliationError: describeError(reconciliationError),
      };
    }
  }
}
