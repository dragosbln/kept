// Scripted transport for the demo page and for driving the widget before
// the agent service exposes its route. The happy path mirrors real turns
// against the demo backend's canonical dataset (order-1001 /
// dana@example.com), including the identity-check-before-disclosure flow,
// and slash commands force each failure mode so the trust UX is demoable
// end to end: /fail /refuse /full /locked /timeout /offline /garbage.

import type { SendMessageRequest, TurnOutcome } from '../protocol/types.js';
import type { KeptTransport, SendResult } from './types.js';

export type MockTransportOptions = {
  /** Simulated turn latency; keep 0 in tests. */
  delayMs?: number;
};

const MOCK_CONVERSATION_ID = 'mock-conversation-1';
const TRACKING_URL = 'https://www.ups.com/track?tracknum=1Z999AA10123456784';

const GREETING_REPLY =
  'Happy to help! To look up your order I first need your order number and the email it was placed with.';
const VERIFIED_REPLY =
  "Thanks, you're verified. Order order-1001 (Blaze Runner Sneakers, Wool Socks ×2) shipped with UPS and is in transit — last scan: “Departed regional facility”. " +
  `Track it here: ${TRACKING_URL} — anything else I can do?`;
const RETURNS_REPLY =
  'I can start a return or refund once your order is verified — send your order number and email. In the real service that request runs through policy checks and may need a human approval.';
const FALLBACK_REPLY =
  'I can help with delivery status, returns, and refunds. If you have your order number and the email on the order, send them over and I’ll take a look.';

export class MockTransport implements KeptTransport {
  private readonly delayMs: number;
  private turnCount = 0;

  constructor(options: MockTransportOptions = {}) {
    this.delayMs = options.delayMs ?? 0;
  }

  async send(request: SendMessageRequest): Promise<SendResult> {
    if (this.delayMs > 0) await delay(this.delayMs);

    const forced = forcedResult(request.message);
    if (forced) return forced;

    if (request.conversationId === undefined) this.turnCount = 0;
    this.turnCount += 1;

    return {
      delivered: true,
      conversationId: MOCK_CONVERSATION_ID,
      outcome: { type: 'reply', message: this.scriptedReply(request.message) },
    };
  }

  private scriptedReply(message: string): string {
    const text = message.toLowerCase();
    if (this.turnCount === 1) return GREETING_REPLY;
    if (/order-1001|\b1001\b/.test(text) && /\S+@\S+\.\S+/.test(text)) return VERIFIED_REPLY;
    if (/refund|return/.test(text)) return RETURNS_REPLY;
    return FALLBACK_REPLY;
  }
}

function forcedResult(message: string): SendResult | null {
  switch (message.trim().toLowerCase()) {
    case '/fail':
      return delivered({ type: 'failed', reason: 'internal' });
    case '/refuse':
      return delivered({ type: 'failed', reason: 'refusal' });
    case '/full':
      return delivered({ type: 'conversation_full' });
    case '/locked':
      return {
        delivered: false,
        failure: { kind: 'http', status: 409, code: 'conversation_locked' },
      };
    case '/timeout':
      return { delivered: false, failure: { kind: 'timeout', afterMs: 60_000 } };
    case '/offline':
      return { delivered: false, failure: { kind: 'network' } };
    case '/garbage':
      return { delivered: false, failure: { kind: 'protocol', detail: 'forced by /garbage' } };
    default:
      return null;
  }
}

function delivered(outcome: TurnOutcome): SendResult {
  return { delivered: true, conversationId: MOCK_CONVERSATION_ID, outcome };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
