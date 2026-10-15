// The YAML case format: the product surface of @kept-hq/evals, the same
// genre of document an audit hands a client. Validated with zod so a bad
// file fails at load, never mid-run, and the types the runner and the
// assertions consume are inferred from the schemas the way the policy
// config's are in core: one definition, no drift.
//
// The block-3 sketch (journal, 2026-09-23) is the source. Conventions:
// - Ordinals are 1-based in files: conversation 1, turn 1. The observation
//   indexes them 0-based.
// - A case names what its author knows: order ids, lines, emails, section
//   refs. Never a customer key, an absolute epoch or a ledger record id;
//   the runner derives those.
// - Every time is relative to the case clock: fixture ages in the past,
//   clock jumps into the future.

import { z } from 'zod';
import {
  CAP_KINDS,
  DEFAULT_POLICY_CONFIG,
  FAULT_TOGGLES,
  KB_CHUNK_TIERS,
  PolicyConfigSchema,
  RETRIEVAL_VERDICTS,
  type Currency,
  type DenyReason,
  type FaultToggle,
  type OrderShipment,
  type OrderStatus,
  type RefundLedgerRecordStatus,
  type RequireApprovalReason,
  type ToolName,
  type ToolResultState,
  type TurnFailureReason,
} from '@kept-hq/core';

// --- Vocabularies -----------------------------------------------------------
// Each list is checked against the core type it mirrors, so a value core
// renames fails to compile here instead of failing a case at load.

/**
 * The fault toggles by name, core's list (block 4): the runner threads the
 * active ones to the host, which hands them to the seams that act on them
 * and stamps them on every trace. Re-exported so a case file's vocabulary
 * and the command's `--toggle` read from one place.
 */
export { FAULT_TOGGLES };
export type { FaultToggle };

const TOOL_NAMES = [
  'lookup_order',
  'issue_refund',
  'search_policy',
] as const satisfies readonly ToolName[];

const TOOL_RESULT_STATES = [
  'ok',
  'failed',
  'unknown',
] as const satisfies readonly ToolResultState[];

const LEDGER_STATUSES = [
  'pending',
  'attempted',
  'denied',
  'ok',
  'failed',
  'unknown',
] as const satisfies readonly RefundLedgerRecordStatus[];

const CURRENCIES = ['USD', 'EUR'] as const satisfies readonly Currency[];

const ORDER_STATUSES = [
  'pending',
  'partially_shipped',
  'shipped',
  'partially_delivered',
  'delivered',
  'returned',
] as const satisfies readonly OrderStatus[];

const SHIPMENT_STATUSES = [
  'pending',
  'in_transit',
  'out_for_delivery',
  'delivered',
  'returned',
] as const satisfies readonly OrderShipment['status'][];

const TURN_FAILURE_REASONS = [
  'internal',
  'max_rounds',
  'refusal',
  'max_tokens',
  'unknown_stop_reason',
  'empty_reply',
] as const satisfies readonly TurnFailureReason[];

const REQUIRE_APPROVAL_REASONS = [
  'cap_exceeded',
  'no_cap_for_currency',
] as const satisfies readonly RequireApprovalReason[];

const DENY_REASONS = ['not_eligible', 'already_requested'] as const satisfies readonly DenyReason[];

// --- Building blocks --------------------------------------------------------

const ordinal = z.number().int().min(1);
const nonEmpty = z.string().min(1);
const nonNegativeInt = z.number().int().min(0);

/** At least one bound; a count with none says nothing. */
export const CountSchema = z
  .strictObject({
    eq: nonNegativeInt.optional(),
    gte: nonNegativeInt.optional(),
    lte: nonNegativeInt.optional(),
  })
  .refine((count) => count.eq !== undefined || count.gte !== undefined || count.lte !== undefined, {
    message: 'count needs at least one of eq, gte, lte',
  });

/**
 * Which turn a trace-reading assertion looks at, 1-based. A conversation
 * without a turn means every turn of that conversation. Absent, the default
 * is per kind, because the natural scope differs:
 * - `tool_calls` counts over the whole run; counts add up across chats.
 * - `no_write_before_call` checks every conversation on its own: a write
 *   needs its prior call in the same conversation, the only one the model
 *   saw.
 * - `tool_call_sequence` is an order within one conversation: conversation
 *   1, and the schema refuses the shorthand when the case opens more.
 * - the reply, turn and retrieval kinds read the last turn of the run,
 *   because "the reply" means the last one.
 */
export const AtSchema = z.strictObject({
  conversation: ordinal.optional(),
  turn: ordinal.optional(),
});

/**
 * Selects ledger records by what the author knows about the refund. The
 * runner resolves it against the live ledger when the step runs; zero or
 * several matches is a run error, never a guess.
 */
export const RefundSelectorSchema = z.strictObject({
  orderId: nonEmpty,
  orderItemId: nonEmpty.optional(),
  quantity: ordinal.optional(),
});

// --- Fixtures ---------------------------------------------------------------

const OrderItemSchema = z.strictObject({
  id: nonEmpty,
  productId: nonEmpty,
  productName: nonEmpty,
  quantity: ordinal,
  unitPriceMinorUnits: nonNegativeInt,
});

const ShipmentSchema = z.strictObject({
  id: nonEmpty,
  carrier: nonEmpty,
  carrierStatus: z.string().default(''),
  status: z.enum(SHIPMENT_STATUSES),
  trackingNumber: z.string().nullable().default(null),
  items: z.array(z.strictObject({ orderItemId: nonEmpty, quantity: ordinal })).min(1),
});

/** An order as the backend serves it, minus what the runner stamps: timestamps from `ageMs`, the total from the lines. */
export const FixtureOrderSchema = z.strictObject({
  id: nonEmpty,
  email: z.email(),
  status: z.enum(ORDER_STATUSES),
  currency: z.enum(CURRENCIES),
  items: z.array(OrderItemSchema).min(1),
  shipments: z.array(ShipmentSchema).default([]),
  /** How long before the case clock the order was placed. */
  ageMs: nonNegativeInt.default(0),
});

/** A ledger record that existed before the run. Amount, currency and customer key are derived from the order's line. */
export const PriorRefundSchema = z.strictObject({
  orderId: nonEmpty,
  orderItemId: nonEmpty,
  quantity: ordinal,
  status: z.enum(LEDGER_STATUSES),
  /** How long before the case clock the record was created; what the windowed caps count against. */
  ageMs: nonNegativeInt,
});

/** Faults in the commerce platform, as opposed to the block-4 toggles, which are faults in the agent. */
export const BackendFaultsSchema = z.strictObject({
  /** Every issue_refund the backend receives answers with this status instead of executing. */
  issueRefund: z.enum(['failed', 'unknown']).optional(),
});

export const FixturesSchema = z.strictObject({
  /** Start from the canonical demo orders, aged from the case clock; a case order with the same id replaces one. */
  seedDemoOrders: z.boolean().default(true),
  orders: z.array(FixtureOrderSchema).default([]),
  priorRefunds: z.array(PriorRefundSchema).default([]),
  /** The merchant's declared caps: what the composed-cap assertion checks against, whatever a toggle did to the engine. */
  policy: PolicyConfigSchema.default(DEFAULT_POLICY_CONFIG),
  backend: BackendFaultsSchema.prefault({}),
  /**
   * What search_policy searches: the ingested corpus, or nothing. `empty`
   * is the host's policy-search-off mode, every search a no_match: the
   * only deterministic way to reach that verdict through the model, since
   * on this corpus every question the model searches for lands on a
   * section and every question that would miss is one it does not search.
   */
  knowledgeBase: z.enum(['corpus', 'empty']).default('corpus'),
});

// --- Steps ------------------------------------------------------------------

const actor = nonEmpty.default('eval');

export const StepSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('customer_message'),
    /** The conversation this message continues, or opens when first seen. Ordinals open in order: 1, then 2. */
    conversation: ordinal.default(1),
    message: nonEmpty,
  }),
  z.strictObject({
    kind: z.literal('jump_clock'),
    /** Advances the runner's clock and nothing else. */
    byMs: ordinal,
  }),
  z.strictObject({
    kind: z.literal('human_takeover'),
    conversation: ordinal,
    actor,
  }),
  z.strictObject({
    kind: z.literal('approve_refund'),
    refund: RefundSelectorSchema,
    actor,
  }),
  z.strictObject({
    kind: z.literal('deny_refund'),
    refund: RefundSelectorSchema,
    actor,
  }),
  z.strictObject({
    kind: z.literal('reconcile_refund'),
    refund: RefundSelectorSchema,
    actor,
  }),
]);

// --- Assertions -------------------------------------------------------------
// Twelve kinds, every one over the observation (the completed traces, the
// ledger snapshot, the world), never Langfuse (ADR 0001). Three of them
// count matching things and share one shape: `where` narrows, `count`
// bounds. The rest are one question each.

const PolicyDecisionExpectationSchema = z.discriminatedUnion('outcome', [
  z.strictObject({ outcome: z.literal('allow') }),
  z.strictObject({
    outcome: z.literal('require_approval'),
    reason: z.enum(REQUIRE_APPROVAL_REASONS).optional(),
  }),
  z.strictObject({ outcome: z.literal('deny'), reason: z.enum(DENY_REASONS).optional() }),
]);

const TurnOutcomeExpectationSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('reply') }),
  z.strictObject({ type: z.literal('failed'), reason: z.enum(TURN_FAILURE_REASONS).optional() }),
  z.strictObject({ type: z.literal('conversation_full') }),
]);

/** Shared by every assertion: an id for the report and the matrix, and the toggles expected to turn it red. */
const common = {
  /** Unique within the case; defaults to `<position>-<kind>`. */
  id: nonEmpty.optional(),
  /** Under each listed toggle this assertion must fail in at least one run; under any other it must pass in every run. */
  expectRedUnder: z.array(z.enum(FAULT_TOGGLES)).default([]),
};

export const CaseAssertionSchema = z.discriminatedUnion('kind', [
  // The addressed conversation called these tools in this order, as an
  // ordered subsequence: other calls may sit between them.
  z.strictObject({
    kind: z.literal('tool_call_sequence'),
    tools: z.array(z.enum(TOOL_NAMES)).min(1),
    at: AtSchema.optional(),
    ...common,
  }),
  // How many tool_execution spans match. `args` is a subset match on the
  // call's arguments; `state` is the settled result state.
  z.strictObject({
    kind: z.literal('tool_calls'),
    where: z
      .strictObject({
        tool: z.enum(TOOL_NAMES).optional(),
        state: z.enum(TOOL_RESULT_STATES).optional(),
        args: z.record(z.string(), z.unknown()).optional(),
      })
      .prefault({}),
    count: CountSchema,
    at: AtSchema.optional(),
    ...common,
  }),
  // Every call of `write` is preceded by a call of `mustFollow`; with
  // `sharedArg`, by one whose argument of that name has the same value.
  z.strictObject({
    kind: z.literal('no_write_before_call'),
    write: z.enum(TOOL_NAMES),
    mustFollow: z.enum(TOOL_NAMES),
    sharedArg: nonEmpty.optional(),
    at: AtSchema.optional(),
    ...common,
  }),
  // How many ledger records match at the end of the run.
  z.strictObject({
    kind: z.literal('ledger_records'),
    where: z
      .strictObject({
        orderId: nonEmpty.optional(),
        orderItemId: nonEmpty.optional(),
        quantity: ordinal.optional(),
        status: z.array(z.enum(LEDGER_STATUSES)).min(1).optional(),
      })
      .prefault({}),
    count: CountSchema,
    ...common,
  }),
  // The policy_decision span for this refund: outcome, and reason when one
  // is expected. `occurrence` picks among several decisions for one line.
  z.strictObject({
    kind: z.literal('policy_decision'),
    refund: RefundSelectorSchema,
    occurrence: z.enum(['first', 'last']).default('last'),
    expected: PolicyDecisionExpectationSchema,
    ...common,
  }),
  // The money the engine let out on its own, in the cap's scope, stays
  // within the DECLARED cap of that kind and currency: records in attempted,
  // ok or unknown whose decision was allow, one currency, the window ending
  // at the run's clock. Pending records are a human's to decide and do not
  // count, although the ledger reserves them when deciding the next
  // request. per_call checks each record alone; per_order needs orderId;
  // per_customer needs email; per_day needs neither.
  z
    .strictObject({
      kind: z.literal('composed_cap_sum'),
      cap: z.enum(CAP_KINDS),
      currency: z.enum(CURRENCIES),
      orderId: nonEmpty.optional(),
      email: z.email().optional(),
      ...common,
    })
    .refine((a) => a.cap !== 'per_order' || a.orderId !== undefined, {
      message: 'composed_cap_sum: per_order needs orderId',
    })
    .refine((a) => a.cap !== 'per_customer' || a.email !== undefined, {
      message: 'composed_cap_sum: per_customer needs email',
    }),
  // The verdict on the retrieval span(s) of the addressed turn(s).
  z.strictObject({
    kind: z.literal('retrieval_verdict'),
    verdict: z.enum(RETRIEVAL_VERDICTS),
    occurrence: z.enum(['first', 'last', 'every']).default('last'),
    at: AtSchema.optional(),
    ...common,
  }),
  // How many chunks that cleared the threshold (never dropped ones) match,
  // across the retrieval spans of the addressed turn(s).
  z.strictObject({
    kind: z.literal('retrieved_sections'),
    where: z
      .strictObject({
        docId: nonEmpty.optional(),
        sectionRef: nonEmpty.optional(),
        tier: z.enum(KB_CHUNK_TIERS).optional(),
      })
      .prefault({}),
    count: CountSchema,
    at: AtSchema.optional(),
    ...common,
  }),
  // The reply of the addressed turn contains these strings, case-insensitive.
  z.strictObject({
    kind: z.literal('reply_contains'),
    strings: z.array(nonEmpty).min(1),
    mode: z.enum(['all', 'any']).default('all'),
    at: AtSchema.optional(),
    ...common,
  }),
  z.strictObject({
    kind: z.literal('reply_not_contains'),
    strings: z.array(nonEmpty).min(1),
    at: AtSchema.optional(),
    ...common,
  }),
  // The turn span's outcome: reply, failed with a reason, or conversation full.
  z.strictObject({
    kind: z.literal('turn_outcome'),
    expected: TurnOutcomeExpectationSchema,
    at: AtSchema.optional(),
    ...common,
  }),
  // After the take-over of this conversation, no trace of it holds a
  // model_call span.
  z.strictObject({
    kind: z.literal('no_model_call_after_takeover'),
    conversation: ordinal.default(1),
    ...common,
  }),
]);

// --- The case ---------------------------------------------------------------

const EvalCaseObjectSchema = z.strictObject({
  /** Kebab-case, unique across the cases directory; what the report, the quarantine file and `--case` name. */
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, 'a case id is kebab-case'),
  title: nonEmpty,
  description: z.string().optional(),
  /** Selection labels: `smoke` is the subset that runs on push. */
  tags: z.array(nonEmpty).default([]),
  /** Where the case came from, for the reader: an attack script, an EC row of the edge-case matrix. */
  source: z.string().optional(),
  /** The storefront every conversation searches; the retrieval scope. */
  storeId: nonEmpty,
  /** The conversation clock at the first step, ISO 8601; parsed to epoch ms. */
  clock: z.iso.datetime({ offset: true }).transform((iso) => Date.parse(iso)),
  fixtures: FixturesSchema.prefault({}),
  steps: z.array(StepSchema).min(1),
  assertions: z.array(CaseAssertionSchema).min(1),
});

/**
 * The parsed case. Two things happen after the shape check: assertions
 * without an id get `<position>-<kind>`, and the ordinals are checked
 * against the steps, so an assertion about conversation 3 of a two-
 * conversation case fails at load.
 */
export const EvalCaseSchema = EvalCaseObjectSchema.transform((evalCase) => ({
  ...evalCase,
  assertions: evalCase.assertions.map((assertion, index) => ({
    ...assertion,
    id: assertion.id ?? `${index + 1}-${assertion.kind}`,
  })),
})).superRefine((evalCase, ctx) => {
  const issue = (message: string, path: (string | number)[]): void => {
    ctx.addIssue({ code: 'custom', message, path });
  };

  const seen = new Set<string>();
  for (const [index, assertion] of evalCase.assertions.entries()) {
    if (seen.has(assertion.id)) {
      issue(`duplicate assertion id "${assertion.id}"`, ['assertions', index, 'id']);
    }
    seen.add(assertion.id);
  }

  // Conversations open in order and only through a customer message; the
  // turn count per conversation bounds what `at` may address.
  const turns: number[] = [];
  for (const [index, step] of evalCase.steps.entries()) {
    if (step.kind === 'customer_message') {
      if (step.conversation > turns.length + 1) {
        issue(`conversation ${step.conversation} opens before conversation ${turns.length + 1}`, [
          'steps',
          index,
          'conversation',
        ]);
        continue;
      }
      turns[step.conversation - 1] = (turns[step.conversation - 1] ?? 0) + 1;
    } else if (step.kind === 'human_takeover' && step.conversation > turns.length) {
      issue(`conversation ${step.conversation} has not opened yet`, [
        'steps',
        index,
        'conversation',
      ]);
    }
  }

  for (const [index, assertion] of evalCase.assertions.entries()) {
    const at = 'at' in assertion ? assertion.at : undefined;
    if (
      assertion.kind === 'tool_call_sequence' &&
      at?.conversation === undefined &&
      turns.length > 1
    ) {
      issue(
        `tool_call_sequence is an order within one conversation; the case opens ${turns.length}, so at.conversation is required`,
        ['assertions', index, 'at'],
      );
    }
    const conversation =
      assertion.kind === 'no_model_call_after_takeover' ? assertion.conversation : at?.conversation;
    if (conversation !== undefined && conversation > turns.length) {
      issue(`conversation ${conversation} does not exist (the case opens ${turns.length})`, [
        'assertions',
        index,
      ]);
    }
    if (at?.turn !== undefined && at.conversation === undefined) {
      issue('at.turn needs at.conversation', ['assertions', index, 'at']);
    }
    if (at?.turn !== undefined && at.conversation !== undefined) {
      const available = turns[at.conversation - 1] ?? 0;
      if (at.turn > available) {
        issue(`conversation ${at.conversation} has ${available} turn(s), not ${at.turn}`, [
          'assertions',
          index,
          'at',
        ]);
      }
    }
  }
});

export type EvalCase = z.output<typeof EvalCaseSchema>;
export type Fixtures = EvalCase['fixtures'];
export type FixtureOrder = Fixtures['orders'][number];
export type PriorRefund = Fixtures['priorRefunds'][number];
export type BackendFaults = Fixtures['backend'];
export type Step = EvalCase['steps'][number];
export type RefundSelector = z.output<typeof RefundSelectorSchema>;
export type At = z.output<typeof AtSchema>;
export type Count = z.output<typeof CountSchema>;
export type CaseAssertion = EvalCase['assertions'][number];
export type AssertionKind = CaseAssertion['kind'];
export type AssertionOf<K extends AssertionKind> = Extract<CaseAssertion, { kind: K }>;

// --- Quarantine -------------------------------------------------------------

/**
 * A case that runs and reports but never gates. An entry is written by hand
 * the day the case flakes, with the date and the reason, and removed when
 * the cause is fixed.
 */
export const QuarantineEntrySchema = z.strictObject({
  caseId: nonEmpty,
  since: z.iso.date(),
  reason: nonEmpty,
});

export const QuarantineSchema = z.array(QuarantineEntrySchema);

export type QuarantineEntry = z.output<typeof QuarantineEntrySchema>;

// --- Parsing ----------------------------------------------------------------

export function parseEvalCase(raw: unknown, sourceName = 'inline'): EvalCase {
  const result = EvalCaseSchema.safeParse(raw);
  if (!result.success) {
    throw new Error(`${sourceName}: not a valid eval case\n${z.prettifyError(result.error)}`);
  }
  return result.data;
}

export function parseQuarantine(raw: unknown, sourceName = 'inline'): QuarantineEntry[] {
  const result = QuarantineSchema.safeParse(raw ?? []);
  if (!result.success) {
    throw new Error(`${sourceName}: not a valid quarantine list\n${z.prettifyError(result.error)}`);
  }
  return result.data;
}
