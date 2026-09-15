// The policy engine: the deterministic layer that decides whether a write
// may happen, in front of the ledger and the backend, never in the prompt.
//
// Two calls per request, split around the ledger's atomic operation:
//   plan()   — pure, builds the ledger queries the decision needs, on the
//              engine's clock, so the window floors are recorded verbatim.
//   decide() — pure and synchronous, given the query results; runs the
//              eligibility gate, then every cap in the request's currency,
//              and takes the most restrictive verdict.
// The tool hands decide() to the ledger as a closure over the plan; the
// ledger reads, calls it, and writes in one step, so two calls in the same
// tool round cannot both pass on the same snapshot. decide() must stay
// synchronous for that to hold, and its signature says so.
//
// Invariants:
// - Caps never deny; deny is eligibility's verdict. Caps say allow or
//   require_approval, and a currency with no caps configured requires
//   approval rather than allowing: the layer fails closed.
// - Every enabled rule and every cap is evaluated; nothing short-circuits,
//   so the record shows the full math for the inbox and the evals.
// - Equal to the cap is allowed; strictly over is not.
// - The engine sums what the ledger returned and never re-filters it: what
//   counts (statuses, currency, window) is the ledger's predicate, applied
//   once.

import type { SanitizedOrder } from '../backend/types.js';
import type { LedgerQuery, RefundLedgerRecord } from '../refund-ledger/types.js';
import { CAP_REGISTRY } from './caps.js';
import {
  hashPolicyConfig,
  parsePolicyConfig,
  type CapConfig,
  type PolicyEngineConfig,
} from './config.js';
import { DEFAULT_ELIGIBILITY_RULES_ENABLED, ELIGIBILITY_RULES } from './eligibility.js';
import type {
  CapDecision,
  DecisionPlan,
  DecisionRecord,
  DecisionResult,
  DenyReason,
  EligibilityContext,
  EligibilityRuleKind,
  EligibilityRulesEnabled,
  EligibilityVerdict,
  PlanEntry,
  PolicyRequest,
} from './types.js';

export type PolicyEngineOptions = {
  /** Injectable clock: window floors are computed from it, once per plan. */
  now?: () => number;
  /** Per-rule switches over the defaults; the week-4 fault toggles flip these. */
  eligibilityRulesEnabled?: Partial<EligibilityRulesEnabled>;
};

type CapRow = { cap: CapConfig; query: LedgerQuery; records: RefundLedgerRecord[] };

type FailedVerdict = Extract<EligibilityVerdict, { passed: false }>;

export class PolicyEngine {
  readonly config: PolicyEngineConfig;
  readonly configHash: string;
  private readonly now: () => number;
  private readonly rulesEnabled: EligibilityRulesEnabled;

  /** Throws on an invalid config: a boot-time failure, never a per-request one. */
  constructor(config: PolicyEngineConfig, options: PolicyEngineOptions = {}) {
    this.config = parsePolicyConfig(config);
    this.configHash = hashPolicyConfig(this.config);
    this.now = options.now ?? Date.now;
    this.rulesEnabled = {
      ...DEFAULT_ELIGIBILITY_RULES_ENABLED,
      ...options.eligibilityRulesEnabled,
    };
  }

  plan(request: PolicyRequest, order: SanitizedOrder): DecisionPlan {
    // One instant for every window of this plan.
    const now = this.now();

    const capEntries: PlanEntry[] = this.config.caps
      .filter((cap) => cap.currency === request.currency)
      .map((cap) => ({
        type: 'cap',
        cap,
        query: {
          scope: CAP_REGISTRY[cap.kind].scope(request),
          currency: request.currency,
          ...(cap.windowMs === undefined ? {} : { sinceMs: now - cap.windowMs }),
        },
      }));

    // The line's counting records: no window, scoped to this order and line.
    // One currency per order, so the currency filter is a no-op here.
    const lineEntry: PlanEntry = {
      type: 'line',
      query: {
        scope: { kind: 'orderLine', orderId: request.orderId, orderItemId: request.orderItemId },
        currency: request.currency,
      },
    };

    return { request, order, entries: [lineEntry, ...capEntries] };
  }

  decide(plan: DecisionPlan, results: RefundLedgerRecord[][]): DecisionResult {
    // Results at i belong to entries at i. A mismatch is a caller bug; it
    // throws before any write and settles as failed in the executor.
    if (results.length !== plan.entries.length) {
      throw new Error(
        `PolicyEngine.decide: expected ${plan.entries.length} result lists, got ${results.length}`,
      );
    }

    const { request } = plan;
    const decidedAt = this.now();

    // Partition by entry type first: the line's records feed the gate, the
    // cap records feed the rows. Eligibility is a gate before the caps, not
    // a row among them.
    const lineRecords: RefundLedgerRecord[] = [];
    const capRows: CapRow[] = [];
    plan.entries.forEach((entry, index) => {
      const records = results[index] ?? [];
      switch (entry.type) {
        case 'line':
          lineRecords.push(...records);
          break;
        case 'cap':
          capRows.push({ cap: entry.cap, query: entry.query, records });
          break;
        default:
          entry satisfies never;
      }
    });

    const eligibility = this.checkEligibility({
      order: plan.order,
      orderItemId: request.orderItemId,
      quantity: request.quantity,
      lineRecords,
    });
    const base = { configHash: this.configHash, request, eligibility, decidedAt };

    // 1. The gate. Any failure denies and the caps are not evaluated.
    const failures = eligibility.filter((v): v is FailedVerdict => !v.passed);
    if (failures.length > 0) {
      return { outcome: 'deny', reason: denyReasonFor(failures), record: { ...base, perCap: [] } };
    }

    // 2. Fail closed: a currency with no caps configured never auto-allows.
    if (capRows.length === 0) {
      return {
        outcome: 'require_approval',
        reason: 'no_cap_for_currency',
        record: { ...base, perCap: [] },
      };
    }

    // 3. Every cap; the most restrictive verdict wins.
    const perCap = capRows.map((row) => capDecisionFor(row, request));
    const record: DecisionRecord = { ...base, perCap };

    return perCap.some((row) => row.outcome === 'require_approval')
      ? { outcome: 'require_approval', reason: 'cap_exceeded', record }
      : { outcome: 'allow', record };
  }

  /** Every enabled rule, in registry order; no short-circuit. */
  private checkEligibility(ctx: EligibilityContext): EligibilityVerdict[] {
    return (Object.keys(ELIGIBILITY_RULES) as EligibilityRuleKind[])
      .filter((kind) => this.rulesEnabled[kind])
      .map((kind) => ELIGIBILITY_RULES[kind](ctx));
  }
}

/**
 * already_requested only when a reservation is the sole failure: a true
 * ineligibility from any rule outranks it, so the customer is never told a
 * review is pending on a line that could not be refunded anyway.
 */
function denyReasonFor(failures: FailedVerdict[]): DenyReason {
  return failures.every((f) => f.reason === 'requested_exceeds_delivered_minus_reserved')
    ? 'already_requested'
    : 'not_eligible';
}

function capDecisionFor({ cap, query, records }: CapRow, request: PolicyRequest): CapDecision {
  // The amount the backend actually moved once it is known, the expected
  // amount until then. `??`, not `||`: a backend that moved nothing counts
  // as nothing, not as the expected amount.
  const consumed = records.reduce(
    (sum, record) => sum + (record.refundedAmountMinorUnits ?? record.amountMinorUnits),
    0,
  );
  return {
    kind: cap.kind,
    currency: cap.currency,
    capAmountMinorUnits: cap.amountMinorUnits,
    consumedAmountMinorUnits: consumed,
    requestedAmountMinorUnits: request.amountMinorUnits,
    remainingBeforeMinorUnits: cap.amountMinorUnits - consumed,
    outcome:
      consumed + request.amountMinorUnits <= cap.amountMinorUnits ? 'allow' : 'require_approval',
    ...(query.sinceMs === undefined ? {} : { sinceMs: query.sinceMs }),
    contributingRecordIds: records.map((record) => record.id),
  };
}
