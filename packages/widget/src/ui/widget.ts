// Shadow-DOM mount. One host <div> with an open shadow root; no custom
// element registration, so two widget versions meeting on one page have no
// global registry to collide over. The frame and composer are built once;
// per state change only the log, banner, and a handful of attributes
// re-render, and log nodes are reused by item id so scroll position and
// in-progress interactions survive updates.
//
// Focus policy: focus moves only on explicit user actions (open, close,
// retry, start over) — never from render, and never on page load, so the
// widget cannot steal focus from the storefront.

import type { ResolvedWidgetConfig } from '../config.js';
import type { WidgetStore } from '../state/store.js';
import type { ChatItem, CustomerItem, WidgetState } from '../state/types.js';
import type { UiStrings } from '../strings.js';
import { icon } from './icons.js';
import type { IconName } from './icons.js';
import { renderMessageText } from './linkify.js';
import { applyStyles } from './styles.js';

export type KeptWidgetHandle = {
  open(): void;
  close(): void;
  toggle(): void;
  startOver(): void;
  /** Unsubscribes and removes the widget from the page. */
  destroy(): void;
  readonly host: HTMLElement;
};

const INPUT_MAX_HEIGHT_PX = 110;

export function mountWidget(store: WidgetStore, config: ResolvedWidgetConfig): KeptWidgetHandle {
  const { strings } = config;

  const host = document.createElement('div');
  host.setAttribute('data-kept-widget', '');
  host.setAttribute('data-kept-position', config.position);
  // Placement is duplicated inline because inline styles are the only layer
  // page CSS cannot out-cascade without !important — a storefront reset that
  // matches the host element (e.g. "div { position: relative }") must not be
  // able to unpin the widget. Everything inheritable is defended in styles.ts.
  host.style.position = 'fixed';
  host.style.bottom = '20px';
  host.style[config.position] = '20px';
  host.style.display = 'block';
  host.style.zIndex = String(config.zIndex);
  const shadow = host.attachShadow({ mode: 'open' });
  applyStyles(shadow);

  const root = el('div', 'root');
  if (config.accentColor !== null) {
    // A custom accent also replaces the hover shade; a merchant color with
    // a mismatched green hover would look broken.
    root.style.setProperty('--kept-accent', config.accentColor);
    root.style.setProperty('--kept-accent-strong', config.accentColor);
  }

  // --- panel -------------------------------------------------------------

  const panel = el('section', 'panel');
  panel.id = 'kept-panel';
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', strings.title);
  panel.hidden = true;

  const header = el('header', 'header');
  const title = el('p', 'title');
  title.textContent = strings.title;
  const startOverButton = iconButton('refresh', strings.startOverLabel);
  const closeButton = iconButton('close', strings.closeLabel);
  header.append(title, startOverButton, closeButton);

  const log = el('div', 'log');
  log.setAttribute('role', 'log');
  log.setAttribute('aria-live', 'polite');
  const typing = el('div', 'typing');
  typing.setAttribute('role', 'status');
  typing.setAttribute('aria-label', strings.thinkingLabel);
  typing.hidden = true;
  for (let index = 0; index < 3; index += 1) typing.append(el('span', 'dot'));

  const banner = el('div', 'banner');
  banner.hidden = true;
  const bannerText = el('span', 'banner-text');
  bannerText.textContent = strings.conversationFullNotice;
  const newConversationButton = el('button', 'banner-action');
  newConversationButton.type = 'button';
  newConversationButton.textContent = strings.newConversationLabel;
  banner.append(bannerText, newConversationButton);

  const composer = el('form', 'composer');
  const input = document.createElement('textarea');
  input.className = 'input';
  input.rows = 1;
  input.placeholder = strings.inputPlaceholder;
  input.maxLength = config.maxMessageLength;
  input.setAttribute('aria-label', strings.inputLabel);
  input.setAttribute('enterkeyhint', 'send');
  const sendButton = el('button', 'send');
  sendButton.type = 'submit';
  sendButton.setAttribute('aria-label', strings.sendLabel);
  sendButton.append(icon('send'));
  composer.append(input, sendButton);

  const brand = el('div', 'brand');
  brand.textContent = strings.poweredBy;

  panel.append(header, log, banner, composer, brand);

  // --- launcher ----------------------------------------------------------

  const launcher = el('button', 'launcher');
  launcher.type = 'button';
  launcher.setAttribute('aria-haspopup', 'dialog');
  launcher.setAttribute('aria-controls', panel.id);
  const openIcon = icon('chat');
  const closeIcon = icon('close');
  launcher.append(openIcon, closeIcon);

  root.append(panel, launcher);
  shadow.append(root);

  // --- rendering ---------------------------------------------------------

  type CachedItem = { item: ChatItem; retryable: boolean; node: HTMLElement };
  const itemNodes = new Map<string, CachedItem>();
  let lastRenderedState: WidgetState | null = null;

  function syncLog(state: WidgetState): void {
    const lastCustomerId = findLastCustomerId(state.items);
    const nodes: HTMLElement[] = [];
    const seen = new Set<string>();
    for (const item of state.items) {
      seen.add(item.id);
      const retryable =
        item.kind === 'customer' && item.id === lastCustomerId && !state.conversationFull;
      const cached = itemNodes.get(item.id);
      if (cached && cached.item === item && cached.retryable === retryable) {
        nodes.push(cached.node);
        continue;
      }
      const node = buildItemNode(item, retryable, strings, handleRetry);
      itemNodes.set(item.id, { item, retryable, node });
      nodes.push(node);
    }
    for (const id of itemNodes.keys()) {
      if (!seen.has(id)) itemNodes.delete(id);
    }
    log.replaceChildren(...nodes, typing);
  }

  function isNearBottom(): boolean {
    return log.scrollHeight - log.scrollTop - log.clientHeight < 48;
  }

  function render(state: WidgetState): void {
    const wasNearBottom = isNearBottom();
    const becameOpen = state.open && lastRenderedState?.open !== true;

    launcher.setAttribute(
      'aria-label',
      state.open ? strings.launcherCloseLabel : strings.launcherLabel,
    );
    launcher.setAttribute('aria-expanded', String(state.open));
    openIcon.style.display = state.open ? 'none' : '';
    closeIcon.style.display = state.open ? '' : 'none';

    panel.hidden = !state.open;
    typing.hidden = !state.busy;
    banner.hidden = !state.conversationFull;
    composer.hidden = state.conversationFull;
    sendButton.disabled = state.busy;

    syncLog(state);

    // Stick to the bottom on updates unless the customer has scrolled up to
    // read; a freshly opened panel always starts at the latest message.
    if (state.open && (wasNearBottom || becameOpen)) {
      log.scrollTop = log.scrollHeight;
    }
    lastRenderedState = state;
  }

  // --- wiring ------------------------------------------------------------

  function submit(): void {
    const text = input.value;
    const state = store.getState();
    if (text.trim() === '' || state.busy || state.conversationFull) return;
    input.value = '';
    autogrow();
    void store.send(text);
    input.focus();
  }

  function autogrow(): void {
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, INPUT_MAX_HEIGHT_PX)}px`;
  }

  function handleRetry(itemId: string): void {
    void store.retry(itemId);
    // The retry button disappears with the re-render; keep focus somewhere
    // deterministic instead of letting it fall to the page body.
    input.focus();
  }

  launcher.addEventListener('click', () => {
    const willOpen = !store.getState().open;
    store.toggle();
    if (willOpen) input.focus();
  });
  closeButton.addEventListener('click', () => {
    store.close();
    launcher.focus();
  });
  startOverButton.addEventListener('click', () => {
    store.startOver();
    input.focus();
  });
  newConversationButton.addEventListener('click', () => {
    store.startOver();
    input.focus();
  });
  panel.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      store.close();
      launcher.focus();
    }
  });
  composer.addEventListener('submit', (event) => {
    event.preventDefault();
    submit();
  });
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      submit();
    }
  });
  input.addEventListener('input', autogrow);

  const unsubscribe = store.subscribe(render);
  render(store.getState());
  config.target.append(host);
  if (config.openOnLoad) store.open();

  return {
    host,
    open: () => store.open(),
    close: () => store.close(),
    toggle: () => store.toggle(),
    startOver: () => store.startOver(),
    destroy: () => {
      unsubscribe();
      host.remove();
    },
  };
}

// --- item rendering ------------------------------------------------------

function buildItemNode(
  item: ChatItem,
  retryable: boolean,
  strings: UiStrings,
  onRetry: (itemId: string) => void,
): HTMLElement {
  const node = el('div', `item item--${item.kind}`);
  node.setAttribute('data-item-id', item.id);
  const bubble = el('div', 'bubble');
  if (item.kind === 'agent') {
    bubble.append(renderMessageText(item.text));
  } else {
    // Customer text is never linkified — nothing in it needs to be a link,
    // and rendering it verbatim is one less surface to reason about.
    bubble.textContent = item.text;
  }
  node.append(bubble);
  if (item.kind === 'customer') {
    node.setAttribute('data-delivery', item.delivery);
    const meta = buildMeta(item, retryable, strings, onRetry);
    if (meta) node.append(meta);
  }
  return node;
}

function buildMeta(
  item: CustomerItem,
  retryable: boolean,
  strings: UiStrings,
  onRetry: (itemId: string) => void,
): HTMLElement | null {
  if (item.delivery !== 'failed' && item.delivery !== 'unknown') return null;
  const meta = el('div', `meta meta--${item.delivery}`);
  const label = el('span', 'meta-text');
  label.textContent = failureText(item, strings);
  meta.append(label);
  const conversationFull =
    item.failure?.source === 'outcome' && item.failure.reason === 'conversation_full';
  if (retryable && !conversationFull) {
    const retry = el('button', 'retry');
    retry.type = 'button';
    retry.textContent = strings.retryLabel;
    retry.addEventListener('click', () => onRetry(item.id));
    meta.append(retry);
  }
  return meta;
}

function failureText(item: CustomerItem, strings: UiStrings): string {
  const failure = item.failure;
  if (failure?.source === 'outcome') {
    return failure.reason === 'conversation_full' ? strings.deliveryFailed : strings.turnFailed;
  }
  if (
    failure?.source === 'transport' &&
    failure.failure.kind === 'http' &&
    failure.failure.code === 'conversation_locked'
  ) {
    return strings.conversationLocked;
  }
  return item.delivery === 'failed' ? strings.deliveryFailed : strings.deliveryUnknown;
}

function findLastCustomerId(items: readonly ChatItem[]): string | null {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const candidate = items[index];
    if (candidate !== undefined && candidate.kind === 'customer') return candidate.id;
  }
  return null;
}

// --- small helpers -------------------------------------------------------

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  return node;
}

function iconButton(name: IconName, label: string): HTMLButtonElement {
  const button = el('button', 'icon-button');
  button.type = 'button';
  button.setAttribute('aria-label', label);
  button.title = label;
  button.append(icon(name));
  return button;
}
