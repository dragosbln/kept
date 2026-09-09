// The widget's state machine: pure state and transitions, no DOM. The UI
// subscribes and re-renders from immutable snapshots; the transport and the
// session store are injected. Single-flight is enforced here — one turn per
// conversation at a time — mirroring the server's conversation lock instead
// of racing it.

import { generateId } from '../ids.js';
import type { SendMessageRequest } from '../protocol/types.js';
import type { KeptTransport } from '../transport/types.js';
import type { SessionStore } from './session.js';
import type { ChatItem, CustomerItem, WidgetState } from './types.js';

type Listener = (state: WidgetState) => void;

export type WidgetStoreOptions = {
  transport: KeptTransport;
  session: SessionStore;
  /** Rendered locally as the first agent bubble; never a server turn. */
  greeting: string;
};

export class WidgetStore {
  private state: WidgetState;
  private readonly listeners = new Set<Listener>();
  private readonly transport: KeptTransport;
  private readonly session: SessionStore;
  private readonly greeting: string;

  constructor(options: WidgetStoreOptions) {
    this.transport = options.transport;
    this.session = options.session;
    this.greeting = options.greeting;
    const restored = this.session.load();
    this.state = restored ? { ...restored, busy: false } : this.freshState();
  }

  getState(): WidgetState {
    return this.state;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  open(): void {
    if (!this.state.open) this.patch({ open: true });
  }

  close(): void {
    if (this.state.open) this.patch({ open: false });
  }

  toggle(): void {
    this.patch({ open: !this.state.open });
  }

  /**
   * Sends one customer message. The returned promise settles when the turn
   * settles; the UI fires and forgets it and follows along via subscribe.
   */
  async send(text: string): Promise<void> {
    const trimmed = text.trim();
    if (trimmed === '' || this.state.busy || this.state.conversationFull) return;
    const item: CustomerItem = {
      kind: 'customer',
      id: generateId(),
      clientMessageId: generateId(),
      text: trimmed,
      delivery: 'sending',
      failure: null,
    };
    this.patch({ items: [...this.state.items, item], busy: true });
    await this.deliver(item);
  }

  /**
   * Customer-initiated retry. Only the LAST customer message is retryable:
   * re-sending an earlier one would reorder the conversation the server
   * sees. Reuses the original clientMessageId so a server that dedupes can
   * make retry-after-unknown exactly-once.
   */
  async retry(itemId: string): Promise<void> {
    if (this.state.busy || this.state.conversationFull) return;
    const item = this.state.items.find(
      (candidate): candidate is CustomerItem =>
        candidate.kind === 'customer' && candidate.id === itemId,
    );
    if (!item || (item.delivery !== 'failed' && item.delivery !== 'unknown')) return;
    if (item !== this.lastCustomerItem()) return;
    const retrying: CustomerItem = { ...item, delivery: 'sending', failure: null };
    this.patch({ items: this.replaceItem(retrying), busy: true });
    await this.deliver(retrying);
  }

  /** Drops the local transcript and conversation id; the next send starts fresh. */
  startOver(): void {
    if (this.state.busy) return;
    this.session.clear();
    this.patch({ ...this.freshState(), open: this.state.open });
  }

  private async deliver(item: CustomerItem): Promise<void> {
    const request: SendMessageRequest = {
      message: item.text,
      clientMessageId: item.clientMessageId,
      ...(this.state.conversationId !== null ? { conversationId: this.state.conversationId } : {}),
    };

    let result;
    try {
      result = await this.transport.send(request);
    } catch {
      // The transport contract says "never rejects"; if an implementation
      // breaks it anyway, the honest classification is still 'unknown'.
      result = {
        delivered: false as const,
        failure: { kind: 'protocol' as const, detail: 'transport rejected' },
      };
    }

    if (!result.delivered) {
      // 4xx means the server refused before running the turn; everything
      // else is ambiguous and stays that way.
      const delivery =
        result.failure.kind === 'http' && result.failure.status < 500 ? 'failed' : 'unknown';
      this.patch({
        items: this.replaceItem({
          ...item,
          delivery,
          failure: { source: 'transport', failure: result.failure },
        }),
        busy: false,
      });
      return;
    }

    // The server creates the conversation before running the turn, so the id
    // is adopted on every delivered response — including failed outcomes.
    const { outcome } = result;
    if (outcome.type === 'reply') {
      this.patch({
        conversationId: result.conversationId,
        items: [
          ...this.replaceItem({ ...item, delivery: 'delivered', failure: null }),
          { kind: 'agent', id: generateId(), text: outcome.message },
        ],
        busy: false,
      });
      return;
    }
    if (outcome.type === 'failed') {
      // Failed terminals leave server history unchanged (the loop's
      // failure-atomicity invariant), so retrying this text cannot
      // double-append — retry is safe by construction.
      this.patch({
        conversationId: result.conversationId,
        items: this.replaceItem({
          ...item,
          delivery: 'failed',
          failure: { source: 'outcome', reason: outcome.reason },
        }),
        busy: false,
      });
      return;
    }
    this.patch({
      conversationId: result.conversationId,
      items: this.replaceItem({
        ...item,
        delivery: 'failed',
        failure: { source: 'outcome', reason: 'conversation_full' },
      }),
      conversationFull: true,
      busy: false,
    });
  }

  private lastCustomerItem(): CustomerItem | null {
    for (let index = this.state.items.length - 1; index >= 0; index -= 1) {
      const candidate = this.state.items[index];
      if (candidate !== undefined && candidate.kind === 'customer') return candidate;
    }
    return null;
  }

  private replaceItem(replacement: ChatItem): ChatItem[] {
    return this.state.items.map((candidate) =>
      candidate.id === replacement.id ? replacement : candidate,
    );
  }

  private freshState(): WidgetState {
    return {
      open: false,
      conversationId: null,
      items: [{ kind: 'agent', id: generateId(), text: this.greeting }],
      busy: false,
      conversationFull: false,
    };
  }

  private patch(partial: Partial<WidgetState>): void {
    this.state = { ...this.state, ...partial };
    const { open, conversationId, items, conversationFull } = this.state;
    this.session.save({ open, conversationId, items, conversationFull });
    for (const listener of this.listeners) listener(this.state);
  }
}
