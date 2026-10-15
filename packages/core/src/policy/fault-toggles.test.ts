// HAND-WRITTEN (block 4): the caps filter. The first test is the identity
// the skeleton already satisfies; the rest are the names of the invariants
// and land with the body. Per the block-3 lesson, the failing path first:
// a filter that keeps every cap is the false green to rule out.

import { describe, expect, it } from 'vitest';
import { DEFAULT_POLICY_CONFIG, hashPolicyConfig, type PolicyEngineConfig } from './config.js';
import { applyPolicyFaultToggles } from './fault-toggles.js';

const DAY = 24 * 3_600_000;

/** One cap of each kind, so a filter that drops the wrong kind is visible. */
const FOUR_CAPS: PolicyEngineConfig = {
  version: 'test',
  caps: [
    { kind: 'per_call', amountMinorUnits: 5_000, currency: 'USD' },
    { kind: 'per_order', amountMinorUnits: 10_000, currency: 'USD' },
    { kind: 'per_customer', amountMinorUnits: 20_000, currency: 'USD', windowMs: 30 * DAY },
    { kind: 'per_day', amountMinorUnits: 100_000, currency: 'USD', windowMs: DAY },
  ],
};

describe('applyPolicyFaultToggles', () => {
  it('no toggle: the declared config, the same object, the same hash', () => {
    const effective = applyPolicyFaultToggles(FOUR_CAPS, []);
    expect(effective).toBe(FOUR_CAPS);
    expect(hashPolicyConfig(effective)).toBe(hashPolicyConfig(FOUR_CAPS));
    expect(applyPolicyFaultToggles(DEFAULT_POLICY_CONFIG, ['stale-kb'])).toBe(
      DEFAULT_POLICY_CONFIG,
    );
  });

  it.todo('caps-per-call-only keeps only the per_call caps, in their order, and the version');
  it.todo('caps-per-call-only on a config with no per_call cap leaves no caps at all');
  it.todo('caps-per-call-only never mutates the declared config');
  it.todo('the hash of the effective config differs from the declared one under the toggle');
  it.todo(
    'PolicyEngine: constructed with the toggle, `config` and `configHash` are the effective ones and a per-order breach is allowed',
  );
});
