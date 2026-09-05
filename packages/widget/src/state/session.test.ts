// Persistence tests. The two contracts pinned here: stored state is
// structurally validated on the way back in (storage is world-writable from
// the page), and a send interrupted by the page unloading is restored as
// 'unknown' — delivery unconfirmed — never as still-sending, never dropped.

import { beforeEach, describe, expect, it } from 'vitest';
import { SessionStore } from './session.js';
import type { PersistedState } from './session.js';

const KEY = 'session-test';

const baseState: PersistedState = {
  open: true,
  conversationId: 'c-1',
  conversationFull: false,
  items: [
    { kind: 'agent', id: 'a-1', text: 'Hello!' },
    {
      kind: 'customer',
      id: 'u-1',
      clientMessageId: 'cm-1',
      text: 'Where is my order?',
      delivery: 'delivered',
      failure: null,
    },
  ],
};

describe('SessionStore', () => {
  beforeEach(() => {
    window.sessionStorage.clear();
    window.localStorage.clear();
  });

  it('round-trips state through sessionStorage', () => {
    new SessionStore(KEY, 'session').save(baseState);
    const restored = new SessionStore(KEY, 'session').load();
    expect(restored).toEqual(baseState);
  });

  it('uses localStorage in local mode', () => {
    new SessionStore(KEY, 'local').save(baseState);
    expect(window.localStorage.getItem(KEY)).not.toBeNull();
    expect(window.sessionStorage.getItem(KEY)).toBeNull();
    expect(new SessionStore(KEY, 'local').load()).toEqual(baseState);
  });

  it('persists nothing in none mode', () => {
    const store = new SessionStore(KEY, 'none');
    store.save(baseState);
    expect(window.sessionStorage.getItem(KEY)).toBeNull();
    expect(store.load()).toBeNull();
  });

  it('returns null when nothing is stored', () => {
    expect(new SessionStore(KEY, 'session').load()).toBeNull();
  });

  it('drops corrupted JSON', () => {
    window.sessionStorage.setItem(KEY, '{not json');
    expect(new SessionStore(KEY, 'session').load()).toBeNull();
  });

  it('drops envelopes from another schema version', () => {
    window.sessionStorage.setItem(KEY, JSON.stringify({ v: 0, state: baseState }));
    expect(new SessionStore(KEY, 'session').load()).toBeNull();
  });

  it('drops structurally invalid items rather than rendering them', () => {
    window.sessionStorage.setItem(
      KEY,
      JSON.stringify({ v: 1, state: { ...baseState, items: [{ kind: 'agent', text: 42 }] } }),
    );
    expect(new SessionStore(KEY, 'session').load()).toBeNull();
  });

  it("restores an interrupted 'sending' message as unknown and retryable", () => {
    const interrupted: PersistedState = {
      ...baseState,
      items: [
        {
          kind: 'customer',
          id: 'u-2',
          clientMessageId: 'cm-2',
          text: 'Refund please',
          delivery: 'sending',
          failure: null,
        },
      ],
    };
    new SessionStore(KEY, 'session').save(interrupted);
    const restored = new SessionStore(KEY, 'session').load();
    expect(restored?.items[0]).toMatchObject({
      delivery: 'unknown',
      failure: { source: 'transport' },
    });
  });

  it('clear removes the stored envelope', () => {
    const store = new SessionStore(KEY, 'session');
    store.save(baseState);
    store.clear();
    expect(store.load()).toBeNull();
  });

  it('isolates state by storage key', () => {
    new SessionStore('key-a', 'session').save(baseState);
    expect(new SessionStore('key-b', 'session').load()).toBeNull();
  });
});
