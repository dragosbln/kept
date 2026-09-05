// Conversation persistence across page loads. The server exposes no
// conversation-read endpoint in v0, so the transcript the customer sees is
// persisted client-side next to the conversation id. sessionStorage is the
// default: support conversations carry order details, and per-tab storage
// that dies with the tab is the privacy-lean default for an embedded widget.
// Storage is best-effort throughout — privacy modes and quota errors turn
// persistence off, never break the chat.

import type { ChatItem, CustomerItem, WidgetState } from './types.js';

export type StorageMode = 'session' | 'local' | 'none';

export type PersistedState = Pick<
  WidgetState,
  'open' | 'conversationId' | 'items' | 'conversationFull'
>;

/** Bump on any breaking change to PersistedState; old envelopes are dropped. */
const SCHEMA_VERSION = 1;

type Envelope = {
  v: number;
  state: PersistedState;
};

export class SessionStore {
  private readonly key: string;
  private readonly backend: Storage | null;

  constructor(key: string, mode: StorageMode) {
    this.key = key;
    this.backend = resolveBackend(mode);
  }

  load(): PersistedState | null {
    if (!this.backend) return null;
    let raw: string | null;
    try {
      raw = this.backend.getItem(this.key);
    } catch {
      return null;
    }
    if (raw === null) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return null;
    }
    return sanitizePersisted(parsed);
  }

  save(state: PersistedState): void {
    if (!this.backend) return;
    const envelope: Envelope = { v: SCHEMA_VERSION, state };
    try {
      this.backend.setItem(this.key, JSON.stringify(envelope));
    } catch {
      // Quota or privacy mode; the in-memory state stays authoritative.
    }
  }

  clear(): void {
    if (!this.backend) return;
    try {
      this.backend.removeItem(this.key);
    } catch {
      // Nothing to do.
    }
  }
}

function resolveBackend(mode: StorageMode): Storage | null {
  if (mode === 'none') return null;
  try {
    const backend = mode === 'local' ? window.localStorage : window.sessionStorage;
    // Accessing storage can itself throw (privacy modes), and a present
    // backend can still refuse writes; probe once up front.
    const probe = '__kept_widget_probe__';
    backend.setItem(probe, '1');
    backend.removeItem(probe);
    return backend;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Structural validation of a stored envelope. Our own writes are the only
 * expected source, but storage is world-writable from the page, so nothing
 * here is trusted enough to render without checking.
 */
function sanitizePersisted(value: unknown): PersistedState | null {
  if (!isRecord(value) || value['v'] !== SCHEMA_VERSION) return null;
  const state = value['state'];
  if (!isRecord(state)) return null;
  const { open, conversationId, items, conversationFull } = state as Record<string, unknown>;
  if (typeof open !== 'boolean' || typeof conversationFull !== 'boolean') return null;
  if (conversationId !== null && typeof conversationId !== 'string') return null;
  if (!Array.isArray(items)) return null;
  const sanitizedItems: ChatItem[] = [];
  for (const item of items) {
    const sanitized = sanitizeItem(item);
    if (!sanitized) return null;
    sanitizedItems.push(sanitized);
  }
  return { open, conversationId, items: sanitizedItems, conversationFull };
}

function sanitizeItem(value: unknown): ChatItem | null {
  if (!isRecord(value)) return null;
  if (typeof value['id'] !== 'string' || typeof value['text'] !== 'string') return null;
  if (value['kind'] === 'agent') {
    return { kind: 'agent', id: value['id'], text: value['text'] };
  }
  if (value['kind'] !== 'customer' || typeof value['clientMessageId'] !== 'string') return null;
  const item: CustomerItem = {
    kind: 'customer',
    id: value['id'],
    clientMessageId: value['clientMessageId'],
    text: value['text'],
    delivery: 'delivered',
    failure: null,
  };
  switch (value['delivery']) {
    case 'delivered':
      return item;
    case 'failed':
      return {
        ...item,
        delivery: 'failed',
        failure: { source: 'transport', failure: { kind: 'network' } },
      };
    case 'sending':
    case 'unknown':
      // A send interrupted by the page unloading is exactly a "may or may
      // not have gone through": restore it as unconfirmed, retryable.
      return {
        ...item,
        delivery: 'unknown',
        failure: { source: 'transport', failure: { kind: 'network' } },
      };
    default:
      return null;
  }
}
