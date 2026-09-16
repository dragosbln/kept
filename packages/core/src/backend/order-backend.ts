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
   * must not refuse on those grounds.
   *
   * Never throws: a call whose outcome the
   * backend cannot know (the request went out, no answer came back) returns
   * `unknown`, because that is exactly what the caller must record.
   *
   * `key` is the idempotency key: minted by the caller (the ledger record
   * id) and naming one intended write. The contract, pinned by the suite:
   * - at most once per key. A replay with the same key and the same
   *   parameters returns the recorded outcome, ok or failed, and moves
   *   nothing.
   * - The same key with different parameters fails with `key_conflict` and
   *   is never executed.
   * - A new key with the same parameters is a new refund, subject to
   *   quantity.
   * - The outcome is recorded atomically with the execution, so a request
   *   whose outcome the backend itself does not know cannot exist. An
   *   adapter over a platform that cannot promise that answers a replay of
   *   a still-executing request with `unknown` (`in_flight`), never by
   *   executing it again.
   * A replay of a request the backend never received executes it. That is
   * what reconciliation relies on, and why only reconciliation may replay a
   * key: the model is told unknown and told not to retry, and that stays
   * true.
   */
  issueRefund(key: string, params: IssueRefundParams): Promise<IssueRefundResponse>;
}
