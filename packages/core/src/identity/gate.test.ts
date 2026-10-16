// The disclosure gate's contract (block 5). The body is hand-written; these
// pin what it must do, and they are red until it lands, by design: an
// unimplemented gate throws rather than passing.

import { describe, expect, it } from 'vitest';
import { makeDemoOrders } from '../backend/seed-orders.js';
import { IDENTITY_NOT_VERIFIED_RESPONSE, identityVerdict, refuseUnverified } from './gate.js';
import { createConversationIdentity } from './identity.js';

const dana = makeDemoOrders()[0]!; // dana@example.com
const sam = makeDemoOrders()[1]!; // sam@example.com
const NO_TOGGLES: readonly [] = [];

describe('identityVerdict', () => {
  it('passes an order whose email the conversation has proved', () => {
    const identity = createConversationIdentity([dana.email]);
    expect(identityVerdict(dana, identity, NO_TOGGLES)).toBe('verified');
  });

  it('refuses when nothing has been proved', () => {
    expect(identityVerdict(dana, createConversationIdentity(), NO_TOGGLES)).toBe('unverified');
  });

  it("refuses another customer's order: a proof for sam does not open dana's order", () => {
    const identity = createConversationIdentity([sam.email]);
    expect(identityVerdict(dana, identity, NO_TOGGLES)).toBe('unverified');
    expect(identityVerdict(sam, identity, NO_TOGGLES)).toBe('verified');
  });

  it('compares normalized: casing and whitespace in the proof do not matter', () => {
    const identity = createConversationIdentity(['  DANA@Example.com ']);
    expect(identityVerdict(dana, identity, NO_TOGGLES)).toBe('verified');
  });

  it('refuses a missing order exactly like an unverified one, so existence cannot be probed', () => {
    expect(identityVerdict(null, createConversationIdentity([dana.email]), NO_TOGGLES)).toBe(
      'unverified',
    );
    expect(identityVerdict(null, createConversationIdentity(), NO_TOGGLES)).toBe('unverified');
  });

  it('under skip-identity-check passes everything, a missing order included', () => {
    const toggles = ['skip-identity-check'] as const;
    expect(identityVerdict(dana, createConversationIdentity(), toggles)).toBe('verified');
    expect(identityVerdict(null, createConversationIdentity(), toggles)).toBe('verified');
  });

  it('other toggles leave the gate alone', () => {
    const toggles = ['stale-kb', 'swallow-tool-errors', 'caps-per-call-only'] as const;
    expect(identityVerdict(dana, createConversationIdentity(), toggles)).toBe('unverified');
  });
});

describe('refuseUnverified', () => {
  it('settles failed with the uniform text and a record that names the gate, never the order', () => {
    expect(refuseUnverified()).toEqual({
      resultState: 'failed',
      result: { identity: 'unverified' },
      response: IDENTITY_NOT_VERIFIED_RESPONSE,
    });
  });
});
