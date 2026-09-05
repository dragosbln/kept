// Integration tests through the public API: createKeptWidget with the mock
// transport, rendered into happy-dom. Pins the accessibility contract
// (dialog, log, labels), the send flow as a customer experiences it, the
// conversation-full takeover, and teardown.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createKeptWidget } from '../index.js';
import { MockTransport } from '../transport/mock.js';
import type { KeptWidgetHandle } from './widget.js';

function mount(): { handle: KeptWidgetHandle; shadow: ShadowRoot } {
  const handle = createKeptWidget({
    transport: new MockTransport(),
    storage: 'none',
  });
  const shadow = handle.host.shadowRoot;
  if (!shadow) throw new Error('widget host has no shadow root');
  return { handle, shadow };
}

function query<T extends Element>(shadow: ShadowRoot, selector: string): T {
  const node = shadow.querySelector<T>(selector);
  if (!node) throw new Error(`missing ${selector}`);
  return node;
}

async function sendMessage(shadow: ShadowRoot, text: string): Promise<void> {
  const input = query<HTMLTextAreaElement>(shadow, '.input');
  input.value = text;
  query<HTMLFormElement>(shadow, '.composer').dispatchEvent(
    new Event('submit', { bubbles: true, cancelable: true }),
  );
  await vi.waitFor(() => {
    expect(query(shadow, '.typing').hasAttribute('hidden')).toBe(true);
  });
}

describe('createKeptWidget', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('mounts closed, with a labeled launcher and a hidden dialog', () => {
    const { handle, shadow } = mount();
    expect(handle.host.hasAttribute('data-kept-widget')).toBe(true);
    const launcher = query<HTMLButtonElement>(shadow, '.launcher');
    expect(launcher.getAttribute('aria-label')).toBe('Open support chat');
    expect(launcher.getAttribute('aria-expanded')).toBe('false');
    const panel = query(shadow, '.panel');
    expect(panel.getAttribute('role')).toBe('dialog');
    expect(panel.hasAttribute('hidden')).toBe(true);
  });

  it('opens from the launcher and shows the greeting in a live log', () => {
    const { shadow } = mount();
    query<HTMLButtonElement>(shadow, '.launcher').click();
    const panel = query(shadow, '.panel');
    expect(panel.hasAttribute('hidden')).toBe(false);
    const log = query(shadow, '.log');
    expect(log.getAttribute('role')).toBe('log');
    expect(log.getAttribute('aria-live')).toBe('polite');
    expect(shadow.querySelectorAll('.item--agent')).toHaveLength(1);
  });

  it('sends a message and renders the customer bubble and the reply', async () => {
    const { shadow } = mount();
    query<HTMLButtonElement>(shadow, '.launcher').click();
    await sendMessage(shadow, 'Where is my order?');
    const customer = query(shadow, '.item--customer');
    expect(customer.textContent).toContain('Where is my order?');
    expect(customer.getAttribute('data-delivery')).toBe('delivered');
    expect(shadow.querySelectorAll('.item--agent')).toHaveLength(2);
  });

  it('marks a failed turn on the message and offers a retry', async () => {
    const { shadow } = mount();
    query<HTMLButtonElement>(shadow, '.launcher').click();
    await sendMessage(shadow, '/fail');
    const customer = query(shadow, '.item--customer');
    expect(customer.getAttribute('data-delivery')).toBe('failed');
    expect(query(shadow, '.meta').textContent).toContain(
      'Something went wrong handling this message',
    );
    expect(shadow.querySelector('.retry')).not.toBeNull();
  });

  it('shows delivery-unconfirmed, not failure, for an ambiguous transport error', async () => {
    const { shadow } = mount();
    query<HTMLButtonElement>(shadow, '.launcher').click();
    await sendMessage(shadow, '/offline');
    const customer = query(shadow, '.item--customer');
    expect(customer.getAttribute('data-delivery')).toBe('unknown');
    expect(query(shadow, '.meta').textContent).toContain('Delivery unconfirmed');
  });

  it('swaps the composer for the start-over banner when the conversation fills', async () => {
    const { shadow } = mount();
    query<HTMLButtonElement>(shadow, '.launcher').click();
    await sendMessage(shadow, '/full');
    expect(query(shadow, '.banner').hasAttribute('hidden')).toBe(false);
    expect(query(shadow, '.composer').hasAttribute('hidden')).toBe(true);
    query<HTMLButtonElement>(shadow, '.banner-action').click();
    expect(query(shadow, '.banner').hasAttribute('hidden')).toBe(true);
    expect(query(shadow, '.composer').hasAttribute('hidden')).toBe(false);
    expect(shadow.querySelectorAll('.item--customer')).toHaveLength(0);
  });

  it('closes on Escape', () => {
    const { shadow } = mount();
    query<HTMLButtonElement>(shadow, '.launcher').click();
    query(shadow, '.panel').dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
    );
    expect(query(shadow, '.panel').hasAttribute('hidden')).toBe(true);
  });

  it('destroy removes the widget from the page', () => {
    const { handle } = mount();
    expect(document.querySelector('[data-kept-widget]')).not.toBeNull();
    handle.destroy();
    expect(document.querySelector('[data-kept-widget]')).toBeNull();
  });
});
