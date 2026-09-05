// Pins the wire contract's strictness: a response either matches the
// contract exactly or is rejected whole — no partial acceptance, no
// coercion of unknown outcome types. The UI's "delivery unconfirmed" state
// depends on this parser never guessing.

import { describe, expect, it } from 'vitest';
import { parseSendMessageResponse, parseWireErrorCode } from './types.js';

describe('parseSendMessageResponse', () => {
  it('parses a reply outcome', () => {
    const parsed = parseSendMessageResponse({
      conversationId: 'c-1',
      outcome: { type: 'reply', message: 'On its way.' },
    });
    expect(parsed).toEqual({
      conversationId: 'c-1',
      outcome: { type: 'reply', message: 'On its way.' },
    });
  });

  it('parses every failure reason', () => {
    for (const reason of [
      'internal',
      'max_rounds',
      'refusal',
      'max_tokens',
      'unknown_stop_reason',
      'empty_reply',
    ]) {
      const parsed = parseSendMessageResponse({
        conversationId: 'c-1',
        outcome: { type: 'failed', reason },
      });
      expect(parsed?.outcome).toEqual({ type: 'failed', reason });
    }
  });

  it('parses conversation_full', () => {
    const parsed = parseSendMessageResponse({
      conversationId: 'c-1',
      outcome: { type: 'conversation_full' },
    });
    expect(parsed?.outcome).toEqual({ type: 'conversation_full' });
  });

  it('rejects a missing or empty conversationId', () => {
    expect(parseSendMessageResponse({ outcome: { type: 'reply', message: 'x' } })).toBeNull();
    expect(
      parseSendMessageResponse({
        conversationId: '',
        outcome: { type: 'reply', message: 'x' },
      }),
    ).toBeNull();
  });

  it('rejects an unknown outcome type instead of coercing it', () => {
    expect(
      parseSendMessageResponse({
        conversationId: 'c-1',
        outcome: { type: 'streamed', message: 'x' },
      }),
    ).toBeNull();
  });

  it('accepts a failure reason it has never heard of — reasons are informational', () => {
    // A reason added server-side must not become a protocol failure on a
    // widget that has not been redeployed; every reason renders the same.
    const parsed = parseSendMessageResponse({
      conversationId: 'c-1',
      outcome: { type: 'failed', reason: 'policy_denied' },
    });
    expect(parsed?.outcome).toEqual({ type: 'failed', reason: 'policy_denied' });
  });

  it('rejects a failed outcome whose reason is missing or empty', () => {
    expect(
      parseSendMessageResponse({ conversationId: 'c-1', outcome: { type: 'failed' } }),
    ).toBeNull();
    expect(
      parseSendMessageResponse({ conversationId: 'c-1', outcome: { type: 'failed', reason: '' } }),
    ).toBeNull();
  });

  it('rejects a reply outcome without a string message', () => {
    expect(
      parseSendMessageResponse({
        conversationId: 'c-1',
        outcome: { type: 'reply', message: 42 },
      }),
    ).toBeNull();
  });

  it('rejects non-objects', () => {
    expect(parseSendMessageResponse(null)).toBeNull();
    expect(parseSendMessageResponse('reply')).toBeNull();
    expect(parseSendMessageResponse(undefined)).toBeNull();
  });
});

describe('parseWireErrorCode', () => {
  it('extracts the code from an error envelope', () => {
    expect(parseWireErrorCode({ error: { code: 'conversation_locked' } })).toBe(
      'conversation_locked',
    );
  });

  it('returns null for the plain-string envelope the v0 handler sends, and anything else', () => {
    expect(parseWireErrorCode({ error: 'conversation not found' })).toBeNull();
    expect(parseWireErrorCode({ error: {} })).toBeNull();
    expect(parseWireErrorCode({ code: 'x' })).toBeNull();
    expect(parseWireErrorCode(undefined)).toBeNull();
  });
});
