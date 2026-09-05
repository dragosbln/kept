// Script-tag entry, bundled by esbuild into dist/kept-widget.js (IIFE).
//
//   <script
//     src="https://your-host/kept-widget.js"
//     data-kept-endpoint="https://agent.your-host.com"
//   ></script>
//
// Auto-mounts when data-kept-endpoint is present. Always exposes
// window.KeptWidget.create for programmatic use from plain <script> — the
// embed must never throw into the host page, so mount errors are logged
// and swallowed.

import { createKeptWidget } from './index.js';
import type { KeptWidgetConfig } from './config.js';

declare global {
  interface Window {
    KeptWidget?: { create: typeof createKeptWidget };
  }
}

window.KeptWidget = { create: createKeptWidget };

const script = document.currentScript;
if (script instanceof HTMLScriptElement) {
  const config = configFromDataset(script.dataset);
  if (config) mountWhenReady(config);
}

function configFromDataset(dataset: DOMStringMap): KeptWidgetConfig | null {
  const endpoint = dataset['keptEndpoint'];
  if (endpoint === undefined || endpoint === '') return null;
  const config: KeptWidgetConfig = { endpoint };
  const title = dataset['keptTitle'];
  if (title !== undefined) config.title = title;
  const greeting = dataset['keptGreeting'];
  if (greeting !== undefined) config.greeting = greeting;
  const accentColor = dataset['keptAccentColor'];
  if (accentColor !== undefined) config.accentColor = accentColor;
  const position = dataset['keptPosition'];
  if (position === 'left' || position === 'right') config.position = position;
  const storage = dataset['keptStorage'];
  if (storage === 'session' || storage === 'local' || storage === 'none') {
    config.storage = storage;
  }
  const zIndex = Number(dataset['keptZIndex']);
  if (Number.isFinite(zIndex)) config.zIndex = zIndex;
  if (dataset['keptOpen'] === 'true') config.openOnLoad = true;
  return config;
}

function mountWhenReady(config: KeptWidgetConfig): void {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => mount(config), { once: true });
  } else {
    mount(config);
  }
}

function mount(config: KeptWidgetConfig): void {
  try {
    createKeptWidget(config);
  } catch (error) {
    console.error('[kept-widget] failed to mount:', error);
  }
}
