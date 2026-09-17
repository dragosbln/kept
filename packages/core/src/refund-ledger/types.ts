import type { Currency } from '../backend/types.js';
import type { DecisionResult } from '../policy/types.js';
import type { CustomerKey } from './customer-key.js';

export type RefundLedgerRecordStatus =
  'pending' | 'attempted' | 'denied' | 'ok' | 'failed' | 'unknown';

/**
 * The statuses that count toward caps and reserve a line's units: everything
 * that is, or may still become, money out. `failed` and `denied` are the two
 * that never will. One definition, read by the ledger's own query predicate
 * and by the attack driver's display sums.
 */
export const COUNTING_STATUSES: ReadonlySet<RefundLedgerRecordStatus> =
  new Set<RefundLedgerRecordStatus>(['pending', 'attempted', 'ok', 'unknown']);

export type RefundLedgerRecord = {
  id: string;
  /**
   * The idempotency key handed to the backend for this write, minted by the
   * ledger at creation. Equal to the id today; its own field so an adapter's
   * key scheme never leaks into the record's identity.
   */
  idempotencyKey: string;
  callId: string;
  orderId: string;
  orderItemId: string;
  quantity: number;
  customerKey: CustomerKey; // customer identifier for the per-customer caps
  conversationId: string;
  promptHash: string;
  amountMinorUnits: number;
  currency: Currency;
  createdAt: number;
  /**
   * The policy decision that opened this record: outcome, reason and the
   * full caps math. What the inbox shows beside a pending record, and what
   * the audit log will store as-is.
   *
   * Decision time is RefundLedgerRecord.createdAt
   */
  decisionRecord: DecisionResult;
  /**
   * Status transitions:
   * - opened by recordRefund: "pending" when the decision is require_approval, "attempted" when it is allow; a deny opens nothing
   * - human modifies status from "pending":
   *    - "pending" -> "attempted", if human approves
   *    - "pending" -> "denied", if human denies
   * - "attempted" -> "ok" | "failed" | "unknown", based on the response from the backend
   * - "unknown" -> "ok" | "failed" when reconciliation replays the key and the backend answers; an unknown answer leaves it unknown
   * - a human can also reconcile "unknown" -> "ok" or "failed" by hand
   * - "ok" and "failed" are terminal states
   *
   * for calculating caps, records in status 'pending' | 'attempted' | 'ok' | 'unknown' count; records in 'failed' | 'denied' do not (COUNTING_STATUSES)
   */
  status: RefundLedgerRecordStatus;
  backendRefundId?: string;
  refundedAmountMinorUnits?: number;
  refundedAmountCurrency?: Currency;
};

export type RecordRefundParams = Pick<
  RefundLedgerRecord,
  | 'callId'
  | 'orderId'
  | 'orderItemId'
  | 'quantity'
  | 'customerKey'
  | 'conversationId'
  | 'promptHash'
  | 'amountMinorUnits'
  | 'currency'
>;

/**
 * What the atomic operation returns: the decision itself, plus the ledger
 * row it opened when there is one. Deny is the decision result unchanged;
 * allow and require_approval carry the row under `ledgerRecord`. One
 * discriminant, `outcome`, narrows everything: the reason, the caps math in
 * `record`, and whether a row exists. (`record` is the decision record; the
 * ledger row could not share the name.)
 */
export type RecordRefundResult =
  | Extract<DecisionResult, { outcome: 'deny' }>
  | (Exclude<DecisionResult, { outcome: 'deny' }> & { ledgerRecord: RefundLedgerRecord });

/**
 * The vocabulary of a ledger read. Owned here because the ledger decides
 * what a query can say; the policy engine builds queries from it (engine ->
 * ledger, never the reverse). Every query is implicitly restricted to
 * counting records (see COUNTING_STATUSES) in one currency.
 */
export type LedgerScope =
  | { kind: 'none' } // per_call: nothing prior counts
  | { kind: 'all' } // per_day: every counting record
  | { kind: 'customerKey'; value: CustomerKey } // per_customer
  | { kind: 'orderId'; value: string } // per_order
  | { kind: 'orderLine'; orderId: string; orderItemId: string }; // what is reserved or refunded on one line

export type LedgerQuery = {
  scope: LedgerScope;
  currency: Currency;
  /**
   * Trailing-window floor, epoch ms, computed on the caller's clock so the
   * value the ledger compared against is the value recorded on the decision.
   * Absent means no window. A record created exactly at sinceMs is inside.
   */
  sinceMs?: number;
};
