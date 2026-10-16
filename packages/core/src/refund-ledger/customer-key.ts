import { createHash } from 'node:crypto';
import type { Order } from '../backend/types.js';
import { normalizeEmail } from '../identity/identity.js';

/**
 * The ledger's customer identity. Branded so only customerKeyFor() can
 * produce one: a raw email cannot be passed where a key is expected, which
 * is how the email stays out of the ledger by construction.
 */
export type CustomerKey = string & { readonly __brand: 'CustomerKey' };

/**
 * One customer, one key, on every side of the join: the tool derives it
 * when recording, the policy engine derives it when querying. Normalized
 * first, with the same normalizeEmail the identity gate uses, so casing
 * differences in the same address collapse and the gate and the caps agree
 * on who a customer is.
 *
 * Unsalted on purpose: the key must be stable across processes and
 * databases. That makes it pseudonymization, not anonymization — anyone
 * holding an email can compute its key. The production upgrade is a keyed
 * hash (HMAC with a per-deployment secret) behind this same function.
 */
export function customerKeyFor(order: Pick<Order, 'email'>): CustomerKey {
  const normalized = normalizeEmail(order.email);
  return createHash('sha256').update(normalized, 'utf8').digest('hex') as CustomerKey;
}
