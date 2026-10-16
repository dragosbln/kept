// The caps filter (block 4, caps-per-call-only): the toggle keeps per_call
// and nothing else, never touches the declared config, and an engine built
// with it plans, hashes and decides over the filtered caps. The failing
// path first: a filter that keeps every cap is the false green.

import { describe, expect, it } from 'vitest';
import { DEMO_SEED_EPOCH, makeDemoOrders } from '../backend/seed-orders.js';
import { sanitizeOrderForModel } from '../backend/utils.js';
import { customerKeyFor } from '../refund-ledger/customer-key.js';
import { DEFAULT_POLICY_CONFIG, hashPolicyConfig, type PolicyEngineConfig } from './config.js';
import { PolicyEngine } from './engine.js';
import { applyPolicyFaultToggles } from './fault-toggles.js';
import type { DecisionPlan, PolicyRequest } from './types.js';

const DAY = 24 * 3_600_000;
const now = (): number => DEMO_SEED_EPOCH;
/** Results aligned to a plan's entries, all empty: no prior records anywhere. */
const noRecords = (plan: DecisionPlan): never[][] => plan.entries.map(() => []);
const ON = ['caps-per-call-only'] as const;

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

  it('caps-per-call-only keeps only the per_call caps, in their order, and the version', () => {
    const twoPerCall: PolicyEngineConfig = {
      version: 'v2',
      caps: [
        { kind: 'per_order', amountMinorUnits: 10_000, currency: 'USD' },
        { kind: 'per_call', amountMinorUnits: 5_000, currency: 'USD' },
        { kind: 'per_day', amountMinorUnits: 100_000, currency: 'EUR', windowMs: DAY },
        { kind: 'per_call', amountMinorUnits: 4_000, currency: 'EUR' },
      ],
    };
    expect(applyPolicyFaultToggles(twoPerCall, ON)).toEqual({
      version: 'v2',
      caps: [
        { kind: 'per_call', amountMinorUnits: 5_000, currency: 'USD' },
        { kind: 'per_call', amountMinorUnits: 4_000, currency: 'EUR' },
      ],
    });
    // Beside other toggles, the same.
    expect(
      applyPolicyFaultToggles(FOUR_CAPS, ['stale-kb', 'caps-per-call-only']).caps.map(
        (cap) => cap.kind,
      ),
    ).toEqual(['per_call']);
  });

  it('caps-per-call-only on a config with no per_call cap leaves no caps at all', () => {
    const composedOnly: PolicyEngineConfig = {
      version: 'composed',
      caps: [{ kind: 'per_order', amountMinorUnits: 10_000, currency: 'USD' }],
    };
    expect(applyPolicyFaultToggles(composedOnly, ON)).toEqual({ version: 'composed', caps: [] });
  });

  it('caps-per-call-only never mutates the declared config', () => {
    const before = structuredClone(FOUR_CAPS);
    const effective = applyPolicyFaultToggles(FOUR_CAPS, ON);
    expect(effective).not.toBe(FOUR_CAPS);
    expect(effective.caps).not.toBe(FOUR_CAPS.caps);
    expect(FOUR_CAPS).toEqual(before);
  });

  it('the hash of the effective config differs from the declared one under the toggle', () => {
    const effective = applyPolicyFaultToggles(FOUR_CAPS, ON);
    expect(hashPolicyConfig(effective)).not.toBe(hashPolicyConfig(FOUR_CAPS));
    expect(hashPolicyConfig(effective)).toBe(
      hashPolicyConfig({ version: 'test', caps: [FOUR_CAPS.caps[0]!] }),
    );
  });

  it('PolicyEngine: constructed with the toggle, `config` and `configHash` are the effective ones and a per-order breach is allowed', () => {
    // Per-call generous, per-order tight: the request clears the call cap
    // and breaches the order cap, so only the composed cap can stop it.
    const declared: PolicyEngineConfig = {
      version: 'test',
      caps: [
        { kind: 'per_call', amountMinorUnits: 10_000, currency: 'USD' },
        { kind: 'per_order', amountMinorUnits: 5_000, currency: 'USD' },
      ],
    };
    const demo = makeDemoOrders(DEMO_SEED_EPOCH).find((order) => order.id === 'order-1002');
    if (!demo) throw new Error('no demo order-1002');
    const order = sanitizeOrderForModel(demo);
    // order-1002 line 1: one Trail Boot at $89, delivered; the eligibility gate passes it.
    const request: PolicyRequest = {
      action: 'issue_refund',
      customerKey: customerKeyFor({ email: 'sam@example.com' }),
      orderId: 'order-1002',
      orderItemId: 'order-1002-line-1',
      quantity: 1,
      currency: 'USD',
      amountMinorUnits: 8_900,
    };

    const honest = new PolicyEngine(declared, { now });
    const broken = new PolicyEngine(declared, { now, faultToggles: ON });

    expect(broken.config).toEqual({ version: 'test', caps: [declared.caps[0]] });
    expect(broken.configHash).toBe(hashPolicyConfig(broken.config));
    expect(broken.configHash).not.toBe(honest.configHash);

    const brokenPlan = broken.plan(request, order);
    expect(
      brokenPlan.entries.map((entry) => (entry.type === 'line' ? 'line' : entry.cap.kind)),
    ).toEqual(['line', 'per_call']);

    const honestPlan = honest.plan(request, order);
    expect(honest.decide(honestPlan, noRecords(honestPlan)).outcome).not.toBe('allow');
    expect(broken.decide(brokenPlan, noRecords(brokenPlan)).outcome).toBe('allow');
  });
});
