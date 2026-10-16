// The handle and the normalization: plumbing, pinned so the gate can trust
// it. What the gate decides with it is pinned in gate.test.ts.

import { describe, expect, it } from 'vitest';
import { createConversationIdentity, normalizeEmail } from './identity.js';

describe('normalizeEmail', () => {
  it('trims and lowercases, and nothing else', () => {
    expect(normalizeEmail('  Dana@Example.COM ')).toBe('dana@example.com');
    // Plus-addressing and dots are the provider's business; they stay.
    expect(normalizeEmail('dana+kept@example.com')).toBe('dana+kept@example.com');
    expect(normalizeEmail('da.na@example.com')).toBe('da.na@example.com');
  });
});

describe('createConversationIdentity', () => {
  it('starts with nothing proved', () => {
    const identity = createConversationIdentity();
    expect(identity.verifiedEmails).toEqual([]);
    expect(identity.isVerified('dana@example.com')).toBe(false);
  });

  it('a proof is visible however the email is cased or padded, on either side', () => {
    const identity = createConversationIdentity();
    identity.markVerified('  Dana@Example.com ');
    expect(identity.isVerified('dana@example.com')).toBe(true);
    expect(identity.isVerified('DANA@EXAMPLE.COM')).toBe(true);
    expect(identity.verifiedEmails).toEqual(['dana@example.com']);
  });

  it('is idempotent and keeps the order of first proof', () => {
    const identity = createConversationIdentity();
    identity.markVerified('sam@example.com');
    identity.markVerified('dana@example.com');
    identity.markVerified('SAM@example.com');
    expect(identity.verifiedEmails).toEqual(['sam@example.com', 'dana@example.com']);
  });

  it('normalizes a seeded snapshot and treats it as proved', () => {
    const identity = createConversationIdentity([' Dana@Example.com ']);
    expect(identity.isVerified('dana@example.com')).toBe(true);
    expect(identity.verifiedEmails).toEqual(['dana@example.com']);
  });

  it('hands out copies: mutating a snapshot does not reach the handle', () => {
    const identity = createConversationIdentity(['dana@example.com']);
    (identity.verifiedEmails as string[]).push('sneaky@example.com');
    expect(identity.isVerified('sneaky@example.com')).toBe(false);
    expect(identity.verifiedEmails).toEqual(['dana@example.com']);
  });
});
