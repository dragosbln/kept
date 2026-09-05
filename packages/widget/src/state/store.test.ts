// State-machine tests with a scripted fake transport. What is pinned here:
// single-flight, the failed-vs-unknown delivery mapping, conversationId
// adoption (including on failed outcomes — the server creates the
// conversation before running the turn), retry rules (last customer message
// only, clientMessageId reused), and startOver.

import { describe, expect, it } from 'vitest';
import type { SendMessageRequest } from '../protocol/types.js';
import type { KeptTransport, SendResult } from '../transport/types.js';
import { SessionStore } from './session.js';
import { WidgetStore } from './store.js';
import type { CustomerItem } from './types.js';

class FakeTransport implements KeptTransport {
  readonly requests: SendMessageRequest[] = [];
  private readonly script: SendResult[];

  constructor(script: SendResult[]) {
    this.script = [...script];
  }

  async send(request: SendMessageRequest): Promise<SendResult> {
    this.requests.push(request);
    const next = this.script.shift();
    if (!next) throw new Error('FakeTransport script exhausted');
    return next;
  }
}

const replied = (message: string, conversationId = 'c-1'): SendResult => ({
  delivered: true,
  conversationId,
  outcome: { type: 'reply', message },
});

function makeStore(script: SendResult[]): { store: WidgetStore; transport: FakeTransport } {
  const transport = new FakeTransport(script);
  const store = new WidgetStore({
    transport,
    session: new SessionStore('store-test', 'none'),
    greeting: 'Hello!',
  });
  return { store, transport };
}

function customerItems(store: WidgetStore): CustomerItem[] {
  return store.getState().items.filter((item): item is CustomerItem => item.kind === 'customer');
}

describe('WidgetStore', () => {
  it('starts with the greeting as a local agent item', () => {
    const { store } = makeStore([]);
    expect(store.getState().items).toMatchObject([{ kind: 'agent', text: 'Hello!' }]);
    expect(store.getState().busy).toBe(false);
    expect(store.getState().conversationId).toBeNull();
  });

  it('ignores empty and whitespace-only sends', async () => {
    const { store, transport } = makeStore([]);
    await store.send('   \n ');
    expect(transport.requests).toHaveLength(0);
    expect(store.getState().items).toHaveLength(1);
  });

  it('delivers a reply: customer delivered, agent appended, id adopted', async () => {
    const { store, transport } = makeStore([replied('On its way.')]);
    await store.send('Where is my order?');
    const state = store.getState();
    expect(state.busy).toBe(false);
    expect(state.conversationId).toBe('c-1');
    expect(state.items).toMatchObject([
      { kind: 'agent', text: 'Hello!' },
      { kind: 'customer', text: 'Where is my order?', delivery: 'delivered', failure: null },
      { kind: 'agent', text: 'On its way.' },
    ]);
    expect(transport.requests[0]).not.toHaveProperty('conversationId');
  });

  it('is busy while a turn is in flight and refuses a second send', async () => {
    let release!: (result: SendResult) => void;
    const gate = new Promise<SendResult>((resolve) => {
      release = resolve;
    });
    const transport: KeptTransport = { send: () => gate };
    const store = new WidgetStore({
      transport,
      session: new SessionStore('store-test', 'none'),
      greeting: 'Hello!',
    });
    const first = store.send('first');
    expect(store.getState().busy).toBe(true);
    await store.send('second while busy');
    expect(customerItems(store)).toHaveLength(1);
    release(replied('done'));
    await first;
    expect(store.getState().busy).toBe(false);
  });

  it('sends the adopted conversationId on the next turn', async () => {
    const { store, transport } = makeStore([replied('a'), replied('b')]);
    await store.send('one');
    await store.send('two');
    expect(transport.requests[1]?.conversationId).toBe('c-1');
  });

  it('marks a failed outcome as failed and still adopts the conversation id', async () => {
    const { store } = makeStore([
      { delivered: true, conversationId: 'c-9', outcome: { type: 'failed', reason: 'internal' } },
    ]);
    await store.send('hi');
    const [item] = customerItems(store);
    expect(item).toMatchObject({
      delivery: 'failed',
      failure: { source: 'outcome', reason: 'internal' },
    });
    expect(store.getState().conversationId).toBe('c-9');
  });

  it('flags the conversation full and blocks further sends', async () => {
    const { store, transport } = makeStore([
      { delivered: true, conversationId: 'c-1', outcome: { type: 'conversation_full' } },
    ]);
    await store.send('hi');
    expect(store.getState().conversationFull).toBe(true);
    await store.send('another');
    expect(transport.requests).toHaveLength(1);
  });

  it('maps http 4xx to failed and everything ambiguous to unknown', async () => {
    const cases: Array<{ result: SendResult; delivery: string }> = [
      {
        result: {
          delivered: false,
          failure: { kind: 'http', status: 409, code: 'conversation_locked' },
        },
        delivery: 'failed',
      },
      {
        result: { delivered: false, failure: { kind: 'http', status: 500, code: null } },
        delivery: 'unknown',
      },
      { result: { delivered: false, failure: { kind: 'network' } }, delivery: 'unknown' },
      {
        result: { delivered: false, failure: { kind: 'timeout', afterMs: 60_000 } },
        delivery: 'unknown',
      },
      {
        result: { delivered: false, failure: { kind: 'protocol', detail: 'x' } },
        delivery: 'unknown',
      },
    ];
    await Promise.all(
      cases.map(async ({ result, delivery }) => {
        const { store } = makeStore([result]);
        await store.send('hi');
        expect(customerItems(store)[0]?.delivery).toBe(delivery);
        expect(store.getState().busy).toBe(false);
      }),
    );
  });

  it('treats a transport that rejects (contract breach) as unknown', async () => {
    const transport: KeptTransport = {
      send: () => Promise.reject(new Error('broken transport')),
    };
    const store = new WidgetStore({
      transport,
      session: new SessionStore('store-test', 'none'),
      greeting: 'Hello!',
    });
    await store.send('hi');
    expect(customerItems(store)[0]?.delivery).toBe('unknown');
    expect(store.getState().busy).toBe(false);
  });

  it('retries the last failed message, reusing its clientMessageId', async () => {
    const { store, transport } = makeStore([
      { delivered: false, failure: { kind: 'network' } },
      replied('made it'),
    ]);
    await store.send('hi');
    const [item] = customerItems(store);
    await store.retry(item!.id);
    expect(transport.requests).toHaveLength(2);
    expect(transport.requests[1]?.clientMessageId).toBe(transport.requests[0]?.clientMessageId);
    expect(customerItems(store)[0]?.delivery).toBe('delivered');
  });

  it('refuses to retry anything but the last customer message', async () => {
    const { store, transport } = makeStore([
      { delivered: false, failure: { kind: 'http', status: 400, code: 'invalid_request' } },
      replied('second landed'),
    ]);
    await store.send('first');
    const [failedFirst] = customerItems(store);
    await store.send('second');
    await store.retry(failedFirst!.id);
    expect(transport.requests).toHaveLength(2);
  });

  it('refuses to retry a delivered message', async () => {
    const { store, transport } = makeStore([replied('a')]);
    await store.send('hi');
    await store.retry(customerItems(store)[0]!.id);
    expect(transport.requests).toHaveLength(1);
  });

  it('startOver resets to a fresh conversation but keeps the panel open', async () => {
    const { store } = makeStore([
      { delivered: true, conversationId: 'c-1', outcome: { type: 'conversation_full' } },
    ]);
    store.open();
    await store.send('hi');
    store.startOver();
    const state = store.getState();
    expect(state).toMatchObject({ conversationId: null, conversationFull: false, open: true });
    expect(state.items).toMatchObject([{ kind: 'agent', text: 'Hello!' }]);
  });

  it('notifies subscribers and honors unsubscribe', async () => {
    const { store } = makeStore([replied('a')]);
    let notified = 0;
    const unsubscribe = store.subscribe(() => {
      notified += 1;
    });
    await store.send('hi');
    expect(notified).toBeGreaterThan(0);
    const seen = notified;
    unsubscribe();
    store.open();
    expect(notified).toBe(seen);
  });
});
