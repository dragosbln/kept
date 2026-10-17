export type { ConversationIdentity, VerifiedEmails } from './types.js';
export { createConversationIdentity, normalizeEmail } from './identity.js';
export { IDENTITY_NOT_VERIFIED_RESPONSE, identityVerdict, refuseUnverified } from './gate.js';
export type { IdentityVerdict } from './gate.js';
