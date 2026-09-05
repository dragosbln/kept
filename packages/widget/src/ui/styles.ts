// All widget CSS, injected into the shadow root. Embedding rules that keep
// this robust on arbitrary storefronts: every size is in px (rem resolves
// against the HOST page's root font size), and everything themeable is a
// --kept-* custom property that merchants may override from outside.
//
// The inheritance trap this file defends against: page rules that match the
// host element (a normalize-style "* { font-family: … }" is enough) BEAT
// :host rules, and the winning values then inherit into the shadow tree. So
// inheritable typography is pinned on .root — an inner node page CSS cannot
// match — while :host carries only structure and the theme tokens, whose
// override-through-the-host behavior is the documented theming API.

const WIDGET_CSS = `
:host {
  position: fixed;
  bottom: 20px;
  right: 20px;
  display: block;
  --kept-accent: #146c54;
  --kept-accent-strong: #0f5642;
  --kept-on-accent: #ffffff;
  --kept-surface: #ffffff;
  --kept-surface-muted: #f7f7f8;
  --kept-border: #e4e4e7;
  --kept-text: #18181b;
  --kept-text-muted: #71717a;
  --kept-danger: #b42318;
  --kept-warning: #b54708;
}
:host([data-kept-position='left']) {
  right: auto;
  left: 20px;
}
*,
*::before,
*::after {
  box-sizing: border-box;
}
:where(button, a, textarea):focus-visible {
  outline: 2px solid var(--kept-accent);
  outline-offset: 2px;
}

.root {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 12px;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial,
    sans-serif;
  font-size: 14px;
  font-weight: 400;
  font-style: normal;
  line-height: 1.45;
  letter-spacing: normal;
  text-transform: none;
  text-align: left;
  color: var(--kept-text);
}
:host([data-kept-position='left']) .root {
  align-items: flex-start;
}

.launcher {
  display: grid;
  place-items: center;
  width: 56px;
  height: 56px;
  border: none;
  border-radius: 50%;
  background: var(--kept-accent);
  color: var(--kept-on-accent);
  cursor: pointer;
  box-shadow: 0 6px 20px rgba(0, 0, 0, 0.22);
  transition: transform 120ms ease, background 120ms ease;
}
.launcher:hover {
  background: var(--kept-accent-strong);
}
.launcher:active {
  transform: scale(0.94);
}
.launcher svg {
  width: 26px;
  height: 26px;
}

.panel {
  display: flex;
  flex-direction: column;
  width: 378px;
  max-width: calc(100vw - 40px);
  height: min(620px, calc(100vh - 110px));
  height: min(620px, calc(100dvh - 110px));
  background: var(--kept-surface);
  border: 1px solid var(--kept-border);
  border-radius: 16px;
  box-shadow: 0 16px 48px rgba(0, 0, 0, 0.18), 0 3px 10px rgba(0, 0, 0, 0.08);
  overflow: hidden;
}
.panel[hidden] {
  display: none;
}
@media (prefers-reduced-motion: no-preference) {
  .panel {
    animation: kept-pop 160ms ease;
    transform-origin: bottom right;
  }
  :host([data-kept-position='left']) .panel {
    transform-origin: bottom left;
  }
  @keyframes kept-pop {
    from {
      opacity: 0;
      transform: translateY(8px) scale(0.98);
    }
  }
}

.header {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 12px 14px;
  border-bottom: 1px solid var(--kept-border);
}
.title {
  flex: 1;
  min-width: 0;
  margin: 0;
  font-size: 15px;
  font-weight: 600;
  color: var(--kept-text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.icon-button {
  display: grid;
  place-items: center;
  width: 32px;
  height: 32px;
  border: none;
  border-radius: 8px;
  background: transparent;
  color: var(--kept-text-muted);
  cursor: pointer;
}
.icon-button:hover {
  background: var(--kept-surface-muted);
  color: var(--kept-text);
}
.icon-button svg {
  width: 18px;
  height: 18px;
}

.log {
  flex: 1;
  overflow-y: auto;
  overscroll-behavior: contain;
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 16px 14px;
  background: var(--kept-surface-muted);
}
.item {
  display: flex;
  flex-direction: column;
  max-width: 85%;
}
.item--agent {
  align-self: flex-start;
}
.item--customer {
  align-self: flex-end;
  align-items: flex-end;
}
.bubble {
  padding: 9px 13px;
  border-radius: 14px;
  font-size: 14px;
  line-height: 1.45;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.item--agent .bubble {
  background: var(--kept-surface);
  border: 1px solid var(--kept-border);
  color: var(--kept-text);
  border-bottom-left-radius: 4px;
}
.item--customer .bubble {
  background: var(--kept-accent);
  color: var(--kept-on-accent);
  border-bottom-right-radius: 4px;
}
.item--customer[data-delivery='sending'] .bubble {
  opacity: 0.7;
}
.bubble a {
  color: var(--kept-accent);
  text-decoration: underline;
  overflow-wrap: anywhere;
}
.item--customer .bubble a {
  color: inherit;
}
.meta {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 4px;
  font-size: 12px;
  line-height: 1.35;
  text-align: right;
}
.meta--failed {
  color: var(--kept-danger);
}
.meta--unknown {
  color: var(--kept-warning);
}
.retry {
  border: none;
  background: none;
  padding: 0;
  font-size: 12px;
  font-weight: 600;
  color: inherit;
  text-decoration: underline;
  cursor: pointer;
}

.typing {
  align-self: flex-start;
  display: flex;
  gap: 4px;
  padding: 13px 14px;
  background: var(--kept-surface);
  border: 1px solid var(--kept-border);
  border-radius: 14px;
  border-bottom-left-radius: 4px;
}
.typing[hidden] {
  display: none;
}
.typing .dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--kept-text-muted);
}
@media (prefers-reduced-motion: no-preference) {
  .typing .dot {
    animation: kept-bounce 1.2s infinite ease-in-out;
  }
  .typing .dot:nth-child(2) {
    animation-delay: 0.15s;
  }
  .typing .dot:nth-child(3) {
    animation-delay: 0.3s;
  }
  @keyframes kept-bounce {
    0%,
    60%,
    100% {
      transform: translateY(0);
      opacity: 0.5;
    }
    30% {
      transform: translateY(-4px);
      opacity: 1;
    }
  }
}

.banner {
  display: flex;
  flex-direction: column;
  gap: 8px;
  align-items: flex-start;
  padding: 12px 14px;
  border-top: 1px solid var(--kept-border);
  background: #fffaeb;
  color: #7a5209;
  font-size: 13px;
  line-height: 1.4;
}
.banner[hidden] {
  display: none;
}
.banner-action {
  border: 1px solid currentColor;
  background: transparent;
  color: inherit;
  border-radius: 8px;
  padding: 6px 10px;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
}

.composer {
  display: flex;
  align-items: flex-end;
  gap: 8px;
  margin: 0;
  padding: 10px 12px;
  border-top: 1px solid var(--kept-border);
  background: var(--kept-surface);
}
.composer[hidden] {
  display: none;
}
.input {
  flex: 1;
  resize: none;
  border: 1px solid var(--kept-border);
  border-radius: 10px;
  padding: 8px 12px;
  font: inherit;
  font-size: 14px;
  line-height: 1.4;
  color: var(--kept-text);
  background: var(--kept-surface);
  min-height: 36px;
  max-height: 110px;
}
.input:focus-visible {
  outline-offset: -1px;
}
.send {
  display: grid;
  place-items: center;
  flex-shrink: 0;
  width: 36px;
  height: 36px;
  border: none;
  border-radius: 10px;
  background: var(--kept-accent);
  color: var(--kept-on-accent);
  cursor: pointer;
}
.send:hover:enabled {
  background: var(--kept-accent-strong);
}
.send:disabled {
  background: var(--kept-border);
  color: var(--kept-text-muted);
  cursor: default;
}
.send svg {
  width: 18px;
  height: 18px;
}

.brand {
  padding: 5px 0 7px;
  text-align: center;
  font-size: 11px;
  color: var(--kept-text-muted);
  background: var(--kept-surface);
}

@media (max-width: 480px) {
  .panel {
    position: fixed;
    inset: 0;
    width: auto;
    height: auto;
    max-width: none;
    border: none;
    border-radius: 0;
    padding-bottom: env(safe-area-inset-bottom);
  }
}

@media (prefers-reduced-motion: reduce) {
  * {
    animation: none !important;
    transition: none !important;
  }
}
`;

/**
 * Constructable stylesheet when available, <style> element otherwise (the
 * fallback is also the pre-16.4 Safari path, not just a test shim).
 */
export function applyStyles(root: ShadowRoot): void {
  if (typeof CSSStyleSheet !== 'undefined' && 'adoptedStyleSheets' in root) {
    try {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(WIDGET_CSS);
      root.adoptedStyleSheets = [...root.adoptedStyleSheets, sheet];
      return;
    } catch {
      // Fall through to the <style> path.
    }
  }
  const style = document.createElement('style');
  style.textContent = WIDGET_CSS;
  root.append(style);
}
