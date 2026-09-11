import { createHash } from 'node:crypto';
import type { Order } from '../backend/types.js';

/**
 * The ledger's customer identity. Branded so only customerKeyFor() can
 * produce one: a raw email cannot be passed where a key is expected, which
 * is how the email stays out of the ledger by construction.
 */
export type CustomerKey = string & { readonly __brand: 'CustomerKey' };

/**
 * One customer, one key, on every side of the join: the tool derives it
 * when recording, the policy engine derives it when querying. Trim and
 * lowercase first so casing differences in the same address collapse.
 *
 * Unsalted on purpose: the key must be stable across processes and
 * databases. That makes it pseudonymization, not anonymization — anyone
 * holding an email can compute its key. The production upgrade is a keyed
 * hash (HMAC with a per-deployment secret) behind this same function.
 */
export function customerKeyFor(order: Pick<Order, 'email'>): CustomerKey {
  const normalized = order.email.trim().toLowerCase();
  return createHash('sha256').update(normalized, 'utf8').digest('hex') as CustomerKey;
}
