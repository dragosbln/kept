import type { Currency } from '../backend/types.js';
import type { CustomerKey } from './customer-key.js';

export type RefundLedgerRecordStatus =
  'pending' | 'attempted' | 'denied' | 'ok' | 'failed' | 'unknown';

export type RefundLedgerRecord = {
  id: string;
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
  requireApproval: boolean;
  /**
   * Status transitions:
   * - start in "pending" if refund requires approval
   * - start in "attempted" if the refund doesn't require approval
   * - human modifies status from "pending":
   *    - "pending" -> "attempted", if human approves
   *    - "pending" -> "denied", if human denies
   * - "attempted" -> "ok" | "failed" | "unknown", based on the response from the backend
   * - a human can reconcile "unknown" -> "ok" or "failed"
   * - "ok" and "failed" are terminal states
   *
   * for calculating caps, records in status 'pending' | 'attempted' | 'ok' | 'unknown' count; records in 'failed' | 'denied' do not
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
  | 'requireApproval'
>;
