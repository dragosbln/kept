// Reconciliation: the one place a key is replayed. A record the tool left
// as unknown, or as attempted and then never settled (the crash signature),
// is asked again with its own key. The backend's idempotency contract turns
// "we do not know" into the recorded answer, or executes a request that
// never arrived. Called from the inbox and from tests; never from the tool.
// The model is told unknown and told not to retry, and that stays true.

import type { OrderBackend } from '../backend/order-backend.js';
import type { RefundLedger } from '../refund-ledger/refund-ledger.js';
import { isCrashSignature } from '../refund-ledger/refund-ledger.js';
import type { RefundLedgerRecordStatus } from '../refund-ledger/types.js';
import { executeRefund, type RefundExecution } from './execute.js';

export type ReconcileResult =
  | RefundExecution
  | { status: 'skipped'; reason: 'record_not_found' }
  | {
      status: 'skipped';
      /** `in_flight`: attempted but younger than the window, the tool may still be running. */
      reason: 'in_flight' | 'not_reconcilable';
      ledgerStatus: RefundLedgerRecordStatus;
    };

export type ReconcileOptions = {
  /** The instant the window is measured from; injectable for tests. */
  now?: number;
  /** How long a tool call that opened a record may still be running; the executor's tool timeout is the natural value. */
  windowMs: number;
};

export async function reconcileRefund(
  recordId: string,
  ledger: RefundLedger,
  backend: OrderBackend,
  { now = Date.now(), windowMs }: ReconcileOptions,
): Promise<ReconcileResult> {
  const record = await ledger.findRecord(recordId);
  if (!record) {
    return { status: 'skipped', reason: 'record_not_found' };
  }
  if (record.status === 'attempted' && !isCrashSignature(record, now - windowMs)) {
    return { status: 'skipped', reason: 'in_flight', ledgerStatus: record.status };
  }
  if (record.status !== 'attempted' && record.status !== 'unknown') {
    return { status: 'skipped', reason: 'not_reconcilable', ledgerStatus: record.status };
  }
  return executeRefund(record, ledger, backend);
}
