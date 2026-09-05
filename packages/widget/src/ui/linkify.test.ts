// Pins the widget's XSS discipline: message content only ever becomes text
// nodes, except anchors around substrings that re-parse as strict http(s)
// URLs. If one of these tests fails, treat it as a security regression, not
// a formatting bug.

import { describe, expect, it } from 'vitest';
import { renderMessageText } from './linkify.js';

function renderToElement(text: string): HTMLElement {
  const container = document.createElement('div');
  container.append(renderMessageText(text));
  return container;
}

describe('renderMessageText', () => {
  it('renders plain text without creating elements', () => {
    const container = renderToElement('Your order shipped yesterday.');
    expect(container.textContent).toBe('Your order shipped yesterday.');
    expect(container.children).toHaveLength(0);
  });

  it('renders markup in message text as inert text', () => {
    const hostile = '<img src=x onerror=alert(1)> <script>alert(2)</script>';
    const container = renderToElement(hostile);
    expect(container.children).toHaveLength(0);
    expect(container.textContent).toBe(hostile);
  });

  it('linkifies an http(s) URL with safe anchor attributes', () => {
    const container = renderToElement(
      'Track it here: https://www.ups.com/track?tracknum=1Z999AA10123456784 — anything else?',
    );
    const anchor = container.querySelector('a');
    expect(anchor?.href).toBe('https://www.ups.com/track?tracknum=1Z999AA10123456784');
    expect(anchor?.target).toBe('_blank');
    expect(anchor?.rel).toBe('noopener noreferrer');
    expect(container.textContent).toBe(
      'Track it here: https://www.ups.com/track?tracknum=1Z999AA10123456784 — anything else?',
    );
  });

  it('does not linkify non-http(s) schemes', () => {
    for (const text of ['javascript:alert(1)', 'data:text/html,x', 'ftp://files.example.com']) {
      const container = renderToElement(`see ${text} now`);
      expect(container.querySelector('a')).toBeNull();
      expect(container.textContent).toBe(`see ${text} now`);
    }
  });

  it('keeps trailing sentence punctuation out of the link', () => {
    const container = renderToElement('Details at https://example.com/orders.');
    expect(container.querySelector('a')?.href).toBe('https://example.com/orders');
    expect(container.textContent).toBe('Details at https://example.com/orders.');
  });

  it('keeps a wrapping parenthesis out of the link', () => {
    const container = renderToElement('(see https://example.com/a)');
    expect(container.querySelector('a')?.href).toBe('https://example.com/a');
    expect(container.textContent).toBe('(see https://example.com/a)');
  });

  it('keeps balanced parentheses inside the link', () => {
    const container = renderToElement('read https://en.wikipedia.org/wiki/Sneaker_(shoe) today');
    expect(container.querySelector('a')?.href).toBe('https://en.wikipedia.org/wiki/Sneaker_(shoe)');
  });

  it('linkifies multiple URLs in one message', () => {
    const container = renderToElement('a https://one.test b https://two.test c');
    expect(container.querySelectorAll('a')).toHaveLength(2);
  });
});
