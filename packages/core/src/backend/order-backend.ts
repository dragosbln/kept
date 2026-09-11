import type { IssueRefundParams, IssueRefundResponse, Order } from './types.js';

/**
 * The commerce platform behind Kept: reads orders, moves money. Kept decides
 * and records refunds in the RefundLedger; this port only executes them.
 */
export interface OrderBackend {
  findOrder(orderId: string): Promise<Order | null>;
  /**
   * Refunds `quantity` units of one line at the line's unit price; the
   * caller never names an amount. The backend owns exactly one invariant:
   * quantity is a positive integer no larger than what the line contains
   * minus what was already refunded. Everything else — delivery status,
   * caps, approval — is policy, decided in front of this port, so a backend
   * must not refuse on those grounds. Never throws: a call whose outcome the
   * backend cannot know (the request went out, no answer came back) returns
   * `unknown`, because that is exactly what the caller must record. `key` is
   * the idempotency key; its semantics arrive with the idempotency work and
   * are not pinned yet.
   */
  issueRefund(params: IssueRefundParams): Promise<IssueRefundResponse>;
}
