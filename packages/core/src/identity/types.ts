// The identity gate's vocabulary (block 5). A conversation proves who is
// typing one email at a time: the customer names an order id and the email
// on that order, verify_identity finds them to agree, and from then on every
// order that email owns may be disclosed in this conversation. Emails are
// normalized the way the customer key normalizes, so the gate and the
// per-customer cap agree on who a customer is.

/** The emails a conversation has proved, normalized, in order of first proof. */
export type VerifiedEmails = readonly string[];

/**
 * The per-turn handle the tools see. The host builds it from the
 * conversation's verified emails before the turn, every tool receives it
 * through its context, verify_identity is the only writer, and the host
 * reads the snapshot back after the turn to persist it. The loop carries it
 * untouched, like the conversation id.
 */
export interface ConversationIdentity {
  /** Whether this email, normalized, has been proved in this conversation. */
  isVerified(email: string): boolean;
  /** Records a proof. Idempotent: the same email twice is one entry. */
  markVerified(email: string): void;
  /** The snapshot to persist: a copy, in order of first proof. */
  readonly verifiedEmails: VerifiedEmails;
}
