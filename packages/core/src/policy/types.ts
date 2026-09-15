import type { Currency, SanitizedOrder } from '../backend/types.js';
import type { CustomerKey } from '../refund-ledger/customer-key.js';
import type { LedgerQuery, RefundLedgerRecord } from '../refund-ledger/types.js';
import type { CapKind } from './caps.js';
import type { CapConfig } from './config.js';

/** The write actions the engine gates. `create_return` joins when its tool lands. */
export type PolicyAction = 'issue_refund';

export type DecisionOutcome = 'deny' | 'require_approval' | 'allow';

/**
 * What the engine is asked about: the canonical facts of one write, derived
 * by the tool from the order and the ledger's customer key. Nothing here is
 * text the model produced; the amount is computed, never named.
 */
export type PolicyRequest = {
  action: PolicyAction;
  customerKey: CustomerKey;
  orderId: string;
  orderItemId: string;
  quantity: number;
  currency: Currency;
  amountMinorUnits: number;
};

/** A cap alone never denies; deny is eligibility's verdict. */
export type CapOutcome = Extract<DecisionOutcome, 'require_approval' | 'allow'>;

/** One row of the caps math, as the inbox shows it and as an eval reads it. */
export type CapDecision = {
  kind: CapKind;
  currency: Currency;
  capAmountMinorUnits: number;
  consumedAmountMinorUnits: number;
  requestedAmountMinorUnits: number;
  /** Cap minus consumed, before this request. Negative once a human has approved past the cap. */
  remainingBeforeMinorUnits: number;
  outcome: CapOutcome;
  /** The window floor the ledger filtered on; absent for unwindowed kinds. */
  sinceMs?: number;
  /** The counting records behind `consumed`: the inbox's prior-context view. */
  contributingRecordIds: string[];
};

export type EligibilityRuleKind = 'item_not_delivered';

/** Low-cardinality, like every reason in the codebase: evals match on these. */
export type EligibilityFailure =
  | 'nothing_delivered_on_line'
  | 'requested_exceeds_delivered'
  | 'requested_exceeds_delivered_minus_reserved';

export type EligibilityVerdict =
  | { ruleKind: EligibilityRuleKind; passed: true }
  | { ruleKind: EligibilityRuleKind; passed: false; reason: EligibilityFailure };

/**
 * What a rule may read: the sanitized order (canonical fields, no email), the
 * requested line and quantity, and the line's counting records from the same
 * snapshot the caps use. The last one is why eligibility runs inside the
 * atomic ledger operation: without it, "delivered one of two, refund one,
 * ask again" passes both the rule and the backend.
 */
export type EligibilityContext = {
  order: SanitizedOrder;
  orderItemId: string;
  quantity: number;
  lineRecords: RefundLedgerRecord[];
};

export type EligibilityRulesEnabled = { [kind in EligibilityRuleKind]: boolean };

/**
 * The decision as recorded: on the ledger record for the inbox, on the
 * policy_decision span for evals, and later as the audit log's row. One
 * type, every sink.
 */
export type DecisionRecord = {
  configHash: string;
  request: PolicyRequest;
  /** Every enabled rule, evaluated; empty only when no rule is enabled. */
  eligibility: EligibilityVerdict[];
  /** Empty on deny (caps are not evaluated behind a failed gate) and on no_cap_for_currency. */
  perCap: CapDecision[];
};

export type RequireApprovalReason = 'cap_exceeded' | 'no_cap_for_currency';

export type DenyReason = 'not_eligible' | 'already_requested';

/** One function, three outcomes. A reason is present exactly when the outcome is not allow. */
export type DecisionResult =
  | { outcome: 'allow'; record: DecisionRecord }
  | { outcome: 'require_approval'; reason: RequireApprovalReason; record: DecisionRecord }
  | { outcome: 'deny'; reason: DenyReason; record: DecisionRecord };

/**
 * One list, one owner: the ledger's results at i belong to entries at i, and
 * the tool maps entries to queries without knowing what each is for. The
 * type names what the records are, not who reads them: a `line` entry holds
 * the line's counting records; today eligibility reads them.
 */
export type PlanEntry =
  { type: 'cap'; cap: CapConfig; query: LedgerQuery } | { type: 'line'; query: LedgerQuery };

export type DecisionPlan = {
  request: PolicyRequest;
  /** Transient, never recorded: here for the eligibility rules only. */
  order: SanitizedOrder;
  entries: PlanEntry[];
};
