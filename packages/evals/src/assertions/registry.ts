// HAND-WRITTEN (block 3): every assertion type; the signatures are the
// skeleton, the bodies land next. Each entry is a pure function from the
// observation and its own parameters to a result with a reason; nothing
// here awaits, reads a port, or knows about Langfuse (ADR 0001). The registry is keyed by kind, so a case file names a kind
// and the runner looks it up, the way the retrieval query names its
// predicates.
//
// The parameters and the defaults are documented on the schema
// (case/schema.ts); the `at` addressing rule is on AtSchema.

import type { AssertionKind, AssertionOf, CaseAssertion } from '../case/schema.js';
import { notImplemented } from '../run/errors.js';
import type { AssertionResult, Observation } from '../run/types.js';

export type AssertionFn<K extends AssertionKind> = (
  observation: Observation,
  assertion: AssertionOf<K>,
) => AssertionResult;

export type AssertionRegistry = { readonly [K in AssertionKind]: AssertionFn<K> };

export const ASSERTIONS: AssertionRegistry = {
  tool_call_sequence: () => notImplemented('tool_call_sequence'),
  tool_calls: () => notImplemented('tool_calls'),
  no_write_before_call: () => notImplemented('no_write_before_call'),
  ledger_records: () => notImplemented('ledger_records'),
  policy_decision: () => notImplemented('policy_decision'),
  composed_cap_sum: () => notImplemented('composed_cap_sum'),
  retrieval_verdict: () => notImplemented('retrieval_verdict'),
  retrieved_sections: () => notImplemented('retrieved_sections'),
  reply_contains: () => notImplemented('reply_contains'),
  reply_not_contains: () => notImplemented('reply_not_contains'),
  turn_outcome: () => notImplemented('turn_outcome'),
  no_model_call_after_takeover: () => notImplemented('no_model_call_after_takeover'),
};

/**
 * Dispatch by kind. The registry entry and the assertion are correlated on
 * `kind`, which TypeScript cannot follow across an indexed access, so the
 * entry is read as a function of `never` (every entry is assignable to
 * that) and the assertion is narrowed to match.
 */
export function evaluateAssertion(
  observation: Observation,
  assertion: CaseAssertion,
): AssertionResult {
  const check: (observation: Observation, assertion: never) => AssertionResult =
    ASSERTIONS[assertion.kind];
  return check(observation, assertion as never);
}
