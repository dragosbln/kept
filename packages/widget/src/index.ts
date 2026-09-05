// @kept-hq/widget — embeddable post-purchase support chat widget.
//
// Public API for ESM consumers; embed.ts wraps this for the script-tag
// build. Composition happens here and only here: config resolution, the
// session store, the state store, and the shadow-DOM mount. Everything
// else stays constructor-injected and testable in isolation.

import { resolveConfig } from './config.js';
import type { KeptWidgetConfig } from './config.js';
import { SessionStore } from './state/session.js';
import { WidgetStore } from './state/store.js';
import { mountWidget } from './ui/widget.js';
import type { KeptWidgetHandle } from './ui/widget.js';

export function createKeptWidget(config: KeptWidgetConfig): KeptWidgetHandle {
  const resolved = resolveConfig(config);
  const session = new SessionStore(resolved.storageKey, resolved.storage);
  const store = new WidgetStore({
    transport: resolved.transport,
    session,
    greeting: resolved.strings.greeting,
  });
  return mountWidget(store, resolved);
}

export type { KeptWidgetConfig, ResolvedWidgetConfig } from './config.js';
export type { KeptWidgetHandle } from './ui/widget.js';
export type { UiStrings } from './strings.js';
export { DEFAULT_STRINGS } from './strings.js';
export type {
  SendMessageRequest,
  SendMessageResponse,
  TurnFailureReason,
  TurnOutcome,
  WireErrorEnvelope,
} from './protocol/types.js';
export type { KeptTransport, SendResult, TransportFailure } from './transport/types.js';
export { HttpTransport, DEFAULT_TIMEOUT_MS, MESSAGES_PATH } from './transport/http.js';
export type { HttpTransportOptions } from './transport/http.js';
export { MockTransport } from './transport/mock.js';
export type { MockTransportOptions } from './transport/mock.js';
export type { StorageMode } from './state/session.js';
export type {
  AgentItem,
  ChatItem,
  CustomerItem,
  DeliveryState,
  SendFailure,
  WidgetState,
} from './state/types.js';
