// HAND-WRITTEN (block 5): the disclosure gate. Both order tools call it
// before they say a word about an order, so "nothing customer-specific is
// disclosed before verification" is a property of the tool layer, not of the
// prompt. The toggle lives here too: under skip-identity-check the gate
// passes every time, which is the dossier's D1 failure in its incident-
// grounded form, reads and writes not scoped to the verified customer.

import type { Order } from '../backend/types.js';
import type { FaultToggle } from '../fault-toggles.js';
import type { ToolResult } from '../tools/types.js';
import { settle } from '../tools/utils.js';
import { normalizeEmail } from './identity.js';
import type { ConversationIdentity } from './types.js';

export type IdentityVerdict = 'verified' | 'unverified';

/**
 * The one refusal both order tools give when the gate does not pass. Uniform
 * on purpose: a missing order and another customer's order sound the same,
 * so an order id cannot be probed for existence through an unverified
 * conversation (decision 3). `failed`, like a deny: the tool did not do what
 * was asked and nothing was written. The trace-facing record names the gate
 * and nothing about the order.
 */
export const IDENTITY_NOT_VERIFIED_RESPONSE =
  'Identity not verified for this order. Do not describe the order. Ask the customer for the email address used on the order, then call verify_identity with the order id and that email, and wait for its result before calling any other order tool.';

export function refuseUnverified(): ToolResult {
  return settle.failed(IDENTITY_NOT_VERIFIED_RESPONSE, { identity: 'unverified' });
}

/**
 * HAND (block 5). Whether this conversation may be told about `order`.
 *
 * The rule, from the pinned decisions:
 * - under `skip-identity-check` the gate passes every time, `null` included,
 *   so the tool falls through to its own not-found path and behaves exactly
 *   as it did before block 5 (decision 5);
 * - `null`, no such order, is `unverified`: the refusal must not depend on
 *   whether the order exists (decision 3). A verified customer who typos an
 *   order id is sent back through verify_identity, whose failure text tells
 *   them to check the id and the email; that is the accepted cost;
 * - otherwise `verified` exactly when the order's email, normalized, is in
 *   the conversation's verified set (decisions 1 and 2).
 */
export function identityVerdict(
  order: Pick<Order, 'email'> | null,
  identity: ConversationIdentity,
  toggles: readonly FaultToggle[],
): IdentityVerdict {
  if (toggles.includes('skip-identity-check')) {
    return 'verified';
  }
  if (!order) {
    return 'unverified';
  }
  return identity.isVerified(normalizeEmail(order.email)) ? 'verified' : 'unverified';
}
