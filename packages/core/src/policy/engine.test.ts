// Unit tests for the policy engine, pure: no ledger, results are handed to
// decide() directly. What the ledger filters (statuses, currency, window)
// is the ledger's contract and is tested there; here the engine is trusted
// to sum what it is given. Pinned:
// - config validation and the hash rule (equal content, equal hash)
// - plan(): one query per cap in the request's currency, line query first,
//   window floors on the engine's clock
// - the gate: the three delivery failures and which of them is
//   already_requested, plus the disabled-rule path
// - the caps: the equal-to-cap boundary, no short-circuit, consumed from
//   the moved amount when known, fail-closed on an unconfigured currency

import { describe, expect, it } from 'vitest';
import { makeDemoOrders, DEMO_SEED_EPOCH } from '../backend/seed-orders.js';
import { sanitizeOrderForModel } from '../backend/utils.js';
import type { SanitizedOrder } from '../backend/types.js';
import { customerKeyFor } from '../refund-ledger/customer-key.js';
import type { RefundLedgerRecord } from '../refund-ledger/types.js';
import { DEFAULT_POLICY_CONFIG, hashPolicyConfig, type PolicyEngineConfig } from './config.js';
import { PolicyEngine, type PolicyEngineOptions } from './engine.js';
import type { CapKind } from './caps.js';
import type { DecisionPlan, PolicyRequest } from './types.js';

const NOW = DEMO_SEED_EPOCH;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const ORDERS = new Map(makeDemoOrders(NOW).map((demoOrder) => [demoOrder.id, demoOrder]));

function order(id: string): SanitizedOrder {
  const found = ORDERS.get(id);
  if (!found) throw new Error(`no demo order ${id}`);
  return sanitizeOrderForModel(found);
}

const SAM = customerKeyFor({ email: 'sam@example.com' });

/** order-1002 line 1: one Trail Boot at $89, delivered one of two. */
function request(overrides: Partial<PolicyRequest> = {}): PolicyRequest {
  return {
    action: 'issue_refund',
    customerKey: SAM,
    orderId: 'order-1002',
    orderItemId: 'order-1002-line-1',
    quantity: 1,
    currency: 'USD',
    amountMinorUnits: 8900,
    ...overrides,
  };
}

function record(overrides: Partial<RefundLedgerRecord> = {}): RefundLedgerRecord {
  return {
    id: 'rec-1',
    callId: 'call-1',
    orderId: 'order-1002',
    orderItemId: 'order-1002-line-1',
    quantity: 1,
    customerKey: SAM,
    conversationId: 'conv-1',
    promptHash: 'hash-1',
    amountMinorUnits: 8900,
    currency: 'USD',
    createdAt: NOW - HOUR,
    requireApproval: false,
    status: 'ok',
    ...overrides,
  };
}

function config(caps: PolicyEngineConfig['caps']): PolicyEngineConfig {
  return { version: 'test', caps };
}

/** The four default USD caps and nothing else, so tests name one currency. */
const USD_CAPS = config(DEFAULT_POLICY_CONFIG.caps.filter((cap) => cap.currency === 'USD'));

function engine(
  cfg: PolicyEngineConfig = USD_CAPS,
  options: PolicyEngineOptions = {},
): PolicyEngine {
  return new PolicyEngine(cfg, { now: () => NOW, ...options });
}

/**
 * Results aligned to the plan's entries by name, so a test says
 * `{ per_order: [...] }` instead of counting indexes. Unnamed entries get [].
 */
function resultsFor(
  plan: DecisionPlan,
  byName: Partial<Record<CapKind | 'line', RefundLedgerRecord[]>>,
): RefundLedgerRecord[][] {
  return plan.entries.map((entry) =>
    entry.type === 'line' ? (byName.line ?? []) : (byName[entry.cap.kind] ?? []),
  );
}

describe('policy config', () => {
  it('rejects a windowed cap kind without a window, and an unwindowed one with a window', () => {
    expect(() =>
      engine(config([{ kind: 'per_customer', amountMinorUnits: 100, currency: 'USD' }])),
    ).toThrow();
    expect(() =>
      engine(config([{ kind: 'per_call', amountMinorUnits: 100, currency: 'USD', windowMs: 1 }])),
    ).toThrow();
  });

  it('rejects a negative cap amount', () => {
    expect(() =>
      engine(config([{ kind: 'per_call', amountMinorUnits: -1, currency: 'USD' }])),
    ).toThrow();
  });

  it('hashes by content: key order is irrelevant, an amount is not', () => {
    const a = config([{ kind: 'per_call', amountMinorUnits: 100, currency: 'USD' }]);
    const b = {
      caps: [{ currency: 'USD', amountMinorUnits: 100, kind: 'per_call' }],
      version: 'test',
    };
    expect(hashPolicyConfig(a)).toBe(hashPolicyConfig(b as PolicyEngineConfig));
    expect(engine(a).configHash).toBe(hashPolicyConfig(a));

    const c = config([{ kind: 'per_call', amountMinorUnits: 101, currency: 'USD' }]);
    expect(hashPolicyConfig(c)).not.toBe(hashPolicyConfig(a));
  });
});

describe('plan()', () => {
  it('puts the line query first, then one query per cap in the request currency', () => {
    const plan = engine(DEFAULT_POLICY_CONFIG).plan(request(), order('order-1002'));

    expect(plan.entries[0]).toMatchObject({
      type: 'line',
      query: {
        scope: { kind: 'orderLine', orderId: 'order-1002', orderItemId: 'order-1002-line-1' },
        currency: 'USD',
      },
    });
    const capEntries = plan.entries.slice(1);
    expect(capEntries.map((entry) => (entry.type === 'cap' ? entry.cap.kind : entry.type))).toEqual(
      ['per_call', 'per_order', 'per_customer', 'per_day'],
    );
    expect(capEntries.every((entry) => entry.query.currency === 'USD')).toBe(true);
  });

  it('builds each scope from the request and each window floor from the clock', () => {
    const plan = engine().plan(request(), order('order-1002'));
    const queries = Object.fromEntries(
      plan.entries.flatMap((entry) =>
        entry.type === 'cap' ? [[entry.cap.kind, entry.query]] : [],
      ),
    );

    expect(queries['per_call']).toEqual({ scope: { kind: 'none' }, currency: 'USD' });
    expect(queries['per_order']).toEqual({
      scope: { kind: 'orderId', value: 'order-1002' },
      currency: 'USD',
    });
    expect(queries['per_customer']).toEqual({
      scope: { kind: 'customerKey', value: SAM },
      currency: 'USD',
      sinceMs: NOW - 30 * DAY,
    });
    expect(queries['per_day']).toEqual({
      scope: { kind: 'all' },
      currency: 'USD',
      sinceMs: NOW - DAY,
    });
  });
});

describe('decide(): the eligibility gate', () => {
  it('denies not_eligible when nothing on the line is delivered', () => {
    const e = engine();
    const req = request({
      orderId: 'order-1001',
      orderItemId: 'order-1001-line-1',
      amountMinorUnits: 2050,
    });
    const plan = e.plan(req, order('order-1001'));

    const decision = e.decide(plan, resultsFor(plan, {}));

    expect(decision).toMatchObject({ outcome: 'deny', reason: 'not_eligible' });
    expect(decision.record.eligibility).toEqual([
      { ruleKind: 'item_not_delivered', passed: false, reason: 'nothing_delivered_on_line' },
    ]);
    expect(decision.record.perCap).toEqual([]);
  });

  it('denies not_eligible when the request exceeds what is delivered on a split line', () => {
    const e = engine();
    const plan = e.plan(request({ quantity: 2, amountMinorUnits: 17_800 }), order('order-1002'));

    const decision = e.decide(plan, resultsFor(plan, {}));

    expect(decision).toMatchObject({ outcome: 'deny', reason: 'not_eligible' });
    expect(decision.record.eligibility[0]).toMatchObject({ reason: 'requested_exceeds_delivered' });
  });

  it('denies already_requested when a counting record on the line holds the delivered units', () => {
    const e = engine();
    const plan = e.plan(request(), order('order-1002'));
    const pending = record({ id: 'rec-pending', status: 'pending' });

    const decision = e.decide(plan, resultsFor(plan, { line: [pending] }));

    expect(decision).toMatchObject({ outcome: 'deny', reason: 'already_requested' });
    expect(decision.record.eligibility[0]).toMatchObject({
      reason: 'requested_exceeds_delivered_minus_reserved',
    });
  });

  it('lets an undelivered line through to the caps when the rule is disabled', () => {
    const e = engine(USD_CAPS, { eligibilityRulesEnabled: { item_not_delivered: false } });
    const req = request({
      orderId: 'order-1001',
      orderItemId: 'order-1001-line-1',
      amountMinorUnits: 2050,
    });
    const plan = e.plan(req, order('order-1001'));

    const decision = e.decide(plan, resultsFor(plan, {}));

    expect(decision.outcome).toBe('allow');
    expect(decision.record.eligibility).toEqual([]);
    expect(decision.record.perCap).toHaveLength(4);
  });
});

describe('decide(): the caps', () => {
  it('allows an amount equal to the cap and requires approval one unit over it', () => {
    const e = engine(config([{ kind: 'per_call', amountMinorUnits: 8900, currency: 'USD' }]));
    const atCap = e.plan(request(), order('order-1002'));
    const overCap = e.plan(request({ amountMinorUnits: 8901 }), order('order-1002'));

    expect(e.decide(atCap, resultsFor(atCap, {})).outcome).toBe('allow');
    const over = e.decide(overCap, resultsFor(overCap, {}));
    expect(over).toMatchObject({ outcome: 'require_approval', reason: 'cap_exceeded' });
    expect(over.record.perCap[0]).toMatchObject({
      kind: 'per_call',
      consumedAmountMinorUnits: 0,
      remainingBeforeMinorUnits: 8900,
      requestedAmountMinorUnits: 8901,
      outcome: 'require_approval',
    });
  });

  it('evaluates every cap and reports each verdict when one trips', () => {
    const e = engine();
    const plan = e.plan(request(), order('order-1002'));
    // A prior $12 on the same order: per_order ($12 + $89 > $100) trips; per_customer
    // and per_day see the same record and hold.
    const prior = record({
      id: 'rec-prior',
      orderItemId: 'order-1002-line-2',
      amountMinorUnits: 1200,
    });

    const decision = e.decide(
      plan,
      resultsFor(plan, { per_order: [prior], per_customer: [prior], per_day: [prior] }),
    );

    expect(decision).toMatchObject({ outcome: 'require_approval', reason: 'cap_exceeded' });
    const byKind = Object.fromEntries(decision.record.perCap.map((row) => [row.kind, row]));
    expect(byKind['per_call']).toMatchObject({ outcome: 'allow', consumedAmountMinorUnits: 0 });
    expect(byKind['per_order']).toMatchObject({
      outcome: 'require_approval',
      consumedAmountMinorUnits: 1200,
      remainingBeforeMinorUnits: 8800,
      contributingRecordIds: ['rec-prior'],
    });
    expect(byKind['per_customer']).toMatchObject({
      outcome: 'allow',
      consumedAmountMinorUnits: 1200,
      sinceMs: NOW - 30 * DAY,
    });
    expect(byKind['per_day']).toMatchObject({ outcome: 'allow', sinceMs: NOW - DAY });
  });

  it('counts the moved amount once known, the expected amount until then, and zero as zero', () => {
    const e = engine(config([{ kind: 'per_order', amountMinorUnits: 20_000, currency: 'USD' }]));
    const plan = e.plan(request(), order('order-1002'));
    const moved = record({ id: 'moved', amountMinorUnits: 8900, refundedAmountMinorUnits: 5000 });
    const expected = record({ id: 'expected', status: 'attempted', amountMinorUnits: 1200 });
    const nothing = record({ id: 'nothing', amountMinorUnits: 8900, refundedAmountMinorUnits: 0 });

    const decision = e.decide(plan, resultsFor(plan, { per_order: [moved, expected, nothing] }));

    expect(decision.record.perCap[0]).toMatchObject({ consumedAmountMinorUnits: 6200 });
  });

  it('requires approval when the request currency has no caps configured', () => {
    const e = engine(config([{ kind: 'per_call', amountMinorUnits: 10_000, currency: 'EUR' }]));
    const plan = e.plan(request(), order('order-1002'));

    expect(plan.entries).toHaveLength(1);
    const decision = e.decide(plan, resultsFor(plan, {}));
    expect(decision).toMatchObject({ outcome: 'require_approval', reason: 'no_cap_for_currency' });
    expect(decision.record.perCap).toEqual([]);
    expect(decision.record.eligibility).toEqual([{ ruleKind: 'item_not_delivered', passed: true }]);
  });

  it('throws before any decision when the results do not match the plan', () => {
    const e = engine();
    const plan = e.plan(request(), order('order-1002'));

    expect(() => e.decide(plan, [])).toThrow(/expected 5 result lists/);
  });
});
