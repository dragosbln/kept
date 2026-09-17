// The cap registry: one entry per cap kind, saying which ledger records the
// kind aggregates over and whether it is windowed. The only place that knows
// a record field; plan() calls it, the config schema checks against it.
// Iterated, never branched on, so the week-4 caps-per-call-only toggle is a
// filter over the config and nothing here changes.

import type { LedgerScope } from '../refund-ledger/types.js';
import type { PolicyRequest } from './types.js';

export const CAP_KINDS = ['per_call', 'per_order', 'per_customer', 'per_day'] as const;

export type CapKind = (typeof CAP_KINDS)[number];

type CapRegistryEntry = {
  /** Builds the ledger scope for this kind from the request. */
  scope: (request: PolicyRequest) => LedgerScope;
  /** Windowed kinds require a window in config; the others forbid one. */
  windowed: boolean;
};

export const CAP_REGISTRY: Record<CapKind, CapRegistryEntry> = {
  per_call: {
    scope: () => ({ kind: 'none' }),
    windowed: false,
  },
  per_order: {
    scope: (request) => ({ kind: 'orderId', value: request.orderId }),
    windowed: false,
  },
  per_customer: {
    scope: (request) => ({ kind: 'customerKey', value: request.customerKey }),
    windowed: true,
  },
  per_day: {
    scope: () => ({ kind: 'all' }),
    windowed: true,
  },
};
