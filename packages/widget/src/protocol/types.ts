// Wire contract between the widget and the agent service, v0.
//
// Deliberately NOT imported from @kept-hq/core: the widget is a browser
// client of an HTTP API, so its contract is the JSON on the wire — parsed
// and validated here — never the server's internal TypeScript types. The
// outcome names mirror the agent loop's terminal states 1:1: reply ·
// failed(reason) · conversation_full. This module and transport/http.ts
// are the only places that change when the handler's HTTP shape does.

/**
 * Failure reasons the agent loop emits today. The parser accepts any
 * non-empty string here (same `(string & {})` idiom as core's ErrorType):
 * the widget renders every reason with the same copy, so a reason added on
 * the server must not turn into a protocol failure on a widget that has
 * not been redeployed. Outcome TYPES stay strict — those change what the
 * customer sees.
 */
export type KnownTurnFailureReason =
  'internal' | 'max_rounds' | 'refusal' | 'max_tokens' | 'unknown_stop_reason' | 'empty_reply';

export type TurnFailureReason = KnownTurnFailureReason | (string & {});

export type TurnOutcome =
  | { type: 'reply'; message: string }
  | { type: 'failed'; reason: TurnFailureReason }
  | { type: 'conversation_full' };

/** POST body for `{endpoint}/chat`. */
export type SendMessageRequest = {
  /** The customer's message — exactly one per turn. */
  message: string;
  /** Omitted on the first turn; the server creates the conversation. */
  conversationId?: string;
  /**
   * Client-generated id, stable across retries of the same message, so the
   * server MAY dedupe a retry whose first attempt actually landed. The v0
   * handler ignores it; the widget never retries on its own — only the
   * customer does, explicitly.
   */
  clientMessageId: string;
};

export type SendMessageResponse = {
  conversationId: string;
  outcome: TurnOutcome;
};

/**
 * Non-2xx responses carry this envelope, best effort — it may be absent.
 * The v0 handler sends the plain-string form (a human-readable message, not
 * a code); the object form is what a machine-readable code would look like.
 */
export type WireErrorEnvelope = {
  error: string | { code: string; message?: string };
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Strict parse: anything outside the contract returns null and the caller
 * reports a protocol failure — the customer sees "couldn't confirm", never a
 * guess. An unknown outcome type from a newer server is deliberately not
 * coerced into a known one.
 */
export function parseSendMessageResponse(value: unknown): SendMessageResponse | null {
  if (!isRecord(value)) return null;
  if (typeof value['conversationId'] !== 'string' || value['conversationId'] === '') return null;
  const outcome = parseTurnOutcome(value['outcome']);
  if (!outcome) return null;
  return { conversationId: value['conversationId'], outcome };
}

function parseTurnOutcome(value: unknown): TurnOutcome | null {
  if (!isRecord(value)) return null;
  switch (value['type']) {
    case 'reply':
      return typeof value['message'] === 'string'
        ? { type: 'reply', message: value['message'] }
        : null;
    case 'failed': {
      const reason = value['reason'];
      return typeof reason === 'string' && reason !== '' ? { type: 'failed', reason } : null;
    }
    case 'conversation_full':
      return { type: 'conversation_full' };
    default:
      return null;
  }
}

/**
 * Pulls the machine-readable code out of an error envelope, if present.
 * A plain-string `error` (the v0 handler's shape) is a message for humans,
 * not a code, so it yields null and the UI falls back to generic copy.
 */
export function parseWireErrorCode(value: unknown): string | null {
  if (!isRecord(value)) return null;
  const error = value['error'];
  if (!isRecord(error) || typeof error['code'] !== 'string') return null;
  return error['code'];
}
