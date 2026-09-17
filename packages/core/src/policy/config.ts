// The declarative caps config: what a merchant writes, validated once at
// construction, hashed once, and stamped on every decision. Version is a
// claim; the hash is the fact, the same rule the prompts follow.

import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { Currency } from '../backend/types.js';
import { CAP_KINDS, CAP_REGISTRY } from './caps.js';

// Exhaustive by construction: a Currency added to the union fails to compile
// here until it is listed, and the schema's enum is derived from the keys.
const CURRENCY_LIST: Record<Currency, true> = { USD: true, EUR: true };
const CURRENCIES = Object.keys(CURRENCY_LIST) as [Currency, ...Currency[]];

const CapConfigSchema = z
  .object({
    kind: z.enum(CAP_KINDS),
    /**
     * The limit in the currency's minor units. A request equal to it is allowed.
     * 0 allowed, reads as: 'approve everything'
     * */
    amountMinorUnits: z.number().int().nonnegative(),
    currency: z.enum(CURRENCIES),
    /** Trailing window length in ms. Required for windowed kinds, forbidden otherwise. Epoch-based, timezone-free */
    windowMs: z.number().int().positive().optional(),
  })
  .refine((cap) => (cap.windowMs !== undefined) === CAP_REGISTRY[cap.kind].windowed, {
    message: 'windowMs must be present exactly for windowed cap kinds (per_customer, per_day)',
    path: ['windowMs'],
  });

export const PolicyConfigSchema = z.object({
  version: z.string().min(1),
  /**
   * Evaluated in full for every request in the cap's currency. Caps are per
   * currency and never converted: a currency with no caps listed fails
   * closed (see PolicyEngine.decide), it does not fail open.
   */
  caps: z.array(CapConfigSchema),
});

export type CapConfig = z.infer<typeof CapConfigSchema>;
export type PolicyEngineConfig = z.infer<typeof PolicyConfigSchema>;

/** Throws a ZodError on an invalid config; meant for boot, never per request. */
export function parsePolicyConfig(input: unknown): PolicyEngineConfig {
  return PolicyConfigSchema.parse(input);
}

/** Recursively sorts object keys so equal configs serialize to equal bytes. Array order is kept: it is content. */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .toSorted()
        .map((key) => [key, canonicalize(record[key])]),
    );
  }
  return value;
}

export function hashPolicyConfig(config: PolicyEngineConfig): string {
  return createHash('sha256')
    .update(JSON.stringify(canonicalize(config)), 'utf8')
    .digest('hex');
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The prompt-1.0.0 numbers, now enforced in the tool layer: the same caps in
 * every currency, no conversion. Per-customer runs over a trailing thirty
 * days, per-day over a trailing twenty-four hours.
 */
export const DEFAULT_POLICY_CONFIG: PolicyEngineConfig = {
  version: '1.0.0',
  caps: CURRENCIES.flatMap((currency): CapConfig[] => [
    { kind: 'per_call', amountMinorUnits: 10_000, currency },
    { kind: 'per_order', amountMinorUnits: 10_000, currency },
    { kind: 'per_customer', amountMinorUnits: 15_000, currency, windowMs: 30 * DAY_MS },
    { kind: 'per_day', amountMinorUnits: 30_000, currency, windowMs: DAY_MS },
  ]),
};
