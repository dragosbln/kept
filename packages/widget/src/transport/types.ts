// Transport seam. The widget core talks to KeptTransport, never to fetch:
// the HTTP implementation, the demo's scripted mock, and test fakes are
// interchangeable behind it, and a later protocol change (streaming, auth)
// starts here without touching state or UI.

import type { SendMessageRequest, TurnOutcome } from '../protocol/types.js';

/**
 * How a send failed before yielding an outcome. The store maps these onto
 * the message's delivery state with the widget's version of the
 * ok / failed / unknown rule:
 *
 *   - http 4xx — the server refused without running the turn → 'failed'
 *   - everything else (network, timeout, 5xx, unreadable 2xx) — the turn
 *     MAY have run → 'unknown', and the customer is told delivery could
 *     not be confirmed. Never guessed either way.
 */
export type TransportFailure =
  | { kind: 'network' }
  | { kind: 'timeout'; afterMs: number }
  | { kind: 'http'; status: number; code: string | null }
  | { kind: 'protocol'; detail: string };

export type SendResult =
  | { delivered: true; conversationId: string; outcome: TurnOutcome }
  | { delivered: false; failure: TransportFailure };

export interface KeptTransport {
  /** Never rejects: every failure mode is a SendResult. */
  send(request: SendMessageRequest): Promise<SendResult>;
}
