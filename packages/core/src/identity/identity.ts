import type { ConversationIdentity, VerifiedEmails } from './types.js';

/**
 * One normalization for every place an email is compared: the customer key,
 * the identity gate, the verify tool. Trim and lowercase, nothing cleverer:
 * plus-addressing and dots are the mail provider's business, not ours.
 */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** The handle over a conversation's verified emails; see ConversationIdentity. */
export function createConversationIdentity(verified: VerifiedEmails = []): ConversationIdentity {
  const emails = new Set(verified.map(normalizeEmail));
  return {
    isVerified: (email) => emails.has(normalizeEmail(email)),
    markVerified: (email) => {
      emails.add(normalizeEmail(email));
    },
    get verifiedEmails(): VerifiedEmails {
      return [...emails];
    },
  };
}
