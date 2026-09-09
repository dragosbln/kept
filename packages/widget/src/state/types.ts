import type { TurnFailureReason } from '../protocol/types.js';
import type { TransportFailure } from '../transport/types.js';

/**
 * Delivery is tracked per customer message with the same honesty rule as
 * tool results: 'failed' is asserted only when the server is known not to
 * have processed the turn; anything ambiguous is 'unknown' and shown to the
 * customer as "delivery unconfirmed" — never silently dropped, never faked
 * into success or failure.
 */
export type DeliveryState = 'sending' | 'delivered' | 'failed' | 'unknown';

export type SendFailure =
  | { source: 'outcome'; reason: TurnFailureReason | 'conversation_full' }
  | { source: 'transport'; failure: TransportFailure };

export type CustomerItem = {
  kind: 'customer';
  id: string;
  /** Stable across retries of this message; see SendMessageRequest. */
  clientMessageId: string;
  text: string;
  delivery: DeliveryState;
  failure: SendFailure | null;
};

export type AgentItem = {
  kind: 'agent';
  id: string;
  text: string;
};

export type ChatItem = CustomerItem | AgentItem;

export type WidgetState = {
  open: boolean;
  conversationId: string | null;
  items: readonly ChatItem[];
  /** True while a turn is in flight; the store enforces single-flight. */
  busy: boolean;
  /** Set by a conversation_full outcome; only startOver() clears it. */
  conversationFull: boolean;
};
