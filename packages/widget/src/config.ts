// Public configuration surface and its resolution to concrete values.
// Everything past this file works with ResolvedWidgetConfig — fully
// populated, no optionals — so exactOptionalPropertyTypes stays a
// boundary concern instead of leaking through the widget.

import type { StorageMode } from './state/session.js';
import { DEFAULT_STRINGS } from './strings.js';
import type { UiStrings } from './strings.js';
import { HttpTransport } from './transport/http.js';
import type { KeptTransport } from './transport/types.js';

export type KeptWidgetConfig = {
  /** Agent service base URL. Required unless `transport` is provided. */
  endpoint?: string;
  /** Bring-your-own transport: demos, tests, custom auth or protocols. */
  transport?: KeptTransport;
  /** Convenience alias for strings.title. */
  title?: string;
  /** Convenience alias for strings.greeting. */
  greeting?: string;
  position?: 'right' | 'left';
  /** Any CSS color; becomes the --kept-accent token. */
  accentColor?: string;
  zIndex?: number;
  storage?: StorageMode;
  /** Storage key namespace; set it when two widgets share an origin. */
  storageKey?: string;
  requestTimeoutMs?: number;
  maxMessageLength?: number;
  /** Opens the panel on mount without stealing focus. */
  openOnLoad?: boolean;
  /** Mount point; defaults to document.body. */
  target?: HTMLElement;
  strings?: Partial<UiStrings>;
};

export type ResolvedWidgetConfig = {
  transport: KeptTransport;
  position: 'right' | 'left';
  accentColor: string | null;
  zIndex: number;
  storage: StorageMode;
  storageKey: string;
  maxMessageLength: number;
  openOnLoad: boolean;
  target: HTMLElement;
  strings: UiStrings;
};

/** High but not maximal, so a merchant can still layer things above it. */
const DEFAULT_Z_INDEX = 2_147_482_000;

const DEFAULT_MAX_MESSAGE_LENGTH = 2_000;

export function resolveConfig(config: KeptWidgetConfig): ResolvedWidgetConfig {
  const transport =
    config.transport ??
    (config.endpoint !== undefined
      ? new HttpTransport({
          endpoint: config.endpoint,
          ...(config.requestTimeoutMs !== undefined ? { timeoutMs: config.requestTimeoutMs } : {}),
        })
      : null);
  if (!transport) {
    throw new Error('KeptWidget: config.endpoint (or config.transport) is required');
  }

  const strings: UiStrings = {
    ...DEFAULT_STRINGS,
    ...(config.title !== undefined ? { title: config.title } : {}),
    ...(config.greeting !== undefined ? { greeting: config.greeting } : {}),
    ...config.strings,
  };

  return {
    transport,
    position: config.position ?? 'right',
    accentColor: config.accentColor ?? null,
    zIndex: config.zIndex ?? DEFAULT_Z_INDEX,
    storage: config.storage ?? 'session',
    storageKey: config.storageKey ?? 'kept-widget',
    maxMessageLength: config.maxMessageLength ?? DEFAULT_MAX_MESSAGE_LENGTH,
    openOnLoad: config.openOnLoad ?? false,
    target: config.target ?? document.body,
    strings,
  };
}
