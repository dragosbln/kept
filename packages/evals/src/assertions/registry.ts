// HAND-WRITTEN (block 3): every assertion type; the signatures are the
// skeleton, the bodies land next. Each entry is a pure function from the
// observation and its own parameters to a result with a reason; nothing
// here awaits, reads a port, or knows about Langfuse (ADR 0001). The registry is keyed by kind, so a case file names a kind
// and the runner looks it up, the way the retrieval query names its
// predicates.
//
// The parameters and the defaults are documented on the schema
// (case/schema.ts); the `at` addressing rule is on AtSchema.

import {
  type CompletedTrace,
  type CompletedToolExecutionSpanPayload,
  type RefundLedgerRecord,
  customerKeyFor,
  CAP_REGISTRY,
  COUNTING_STATUSES,
  type ToolName,
  type RetrievalResult,
  type RetrievalVerdict,
  type CompletedTurnSpanPayload,
  type CompletedSpanPayload,
} from '@kept-hq/core';
import type { AssertionKind, AssertionOf, At, CaseAssertion, Count } from '../case/schema.js';
import type { AssertionResult, Observation } from '../run/types.js';
import { isDeepStrictEqual } from 'node:util';

export type AssertionFn<K extends AssertionKind> = (
  observation: Observation,
  assertion: AssertionOf<K>,
) => AssertionResult;

export type AssertionRegistry = { readonly [K in AssertionKind]: AssertionFn<K> };

export const ASSERTIONS: AssertionRegistry = {
  tool_call_sequence: (observation, assertion) => {
    const toolCalls = toolCallsIn(tracesAt(observation, assertion.at ?? { conversation: 1 }));
    let cursor = 0;
    let lastFoundSpanIndex = 0;
    toolCalls.forEach((span, index) => {
      if (span.toolName === assertion.tools[cursor]) {
        cursor++;
        lastFoundSpanIndex = index;
      }
    });
    const passed = cursor === assertion.tools.length;
    if (!passed) {
      return fail(
        `Tool call ${assertion.tools[cursor]} not found ordered in sequence: ${toolCalls.map((tool) => tool.toolName).join(', ')}`,
        toolCalls[lastFoundSpanIndex],
      );
    }
    return {
      passed,
    };
  },
  tool_calls: (observation, assertion) => {
    const toolCalls = toolCallsIn(tracesAt(observation, assertion.at));
    let lastFoundSpanIndex = 0;
    const hits = toolCalls.filter((span, index) => {
      const hit =
        (!assertion.where.tool || span.toolName === assertion.where.tool) &&
        (!assertion.where.state || span.resultState === assertion.where.state) &&
        (!assertion.where.args || objectsMatch(span.args, assertion.where.args));
      if (hit) {
        lastFoundSpanIndex = index;
      }
      return hit;
    });
    const passed = compare(hits.length, assertion.count);
    if (!passed) {
      return fail(
        `Unexpected tool calls count: ${hits.length}; expected: ${JSON.stringify(assertion.count)}`,
        toolCalls[lastFoundSpanIndex],
      );
    }
    return {
      passed,
    };
  },
  no_write_before_call: (observation, assertion) => {
    const toCheck = assertion.at
      ? [toolCallsIn(tracesAt(observation, assertion.at))]
      : observation.traces.map((trace) => toolCallsIn(trace));

    for (const conversationToolCalls of toCheck) {
      const writeCalls = conversationToolCalls
        .map((call, index) => ({ call, index }))
        .filter((indexedCall) => indexedCall.call.toolName === assertion.write);
      for (const writeCall of writeCalls) {
        const hit = conversationToolCalls
          .slice(0, writeCall.index)
          .some(
            (preCall) =>
              preCall.toolName === assertion.mustFollow &&
              (!assertion.sharedArg ||
                preCall.args[assertion.sharedArg] === writeCall.call.args[assertion.sharedArg]),
          );

        if (!hit) {
          return fail(
            `Write call not preceeded by mustFollow call: ${writeCall.call.toolName} requires ${assertion.mustFollow}${assertion.sharedArg ? ` with matching args on ${assertion.sharedArg}` : ''}`,
            writeCall.call,
          );
        }
      }
    }
    return {
      passed: true,
    };
  },
  ledger_records: (observation, assertion) => {
    const matchingRecords = matchingRefunds(observation, assertion.where);

    if (!compare(matchingRecords.length, assertion.count)) {
      return fail(
        `Record counts not matching assertion. Expected: ${JSON.stringify(assertion.count)}, received: ${matchingRecords.length}`,
      );
    }

    return {
      passed: true,
    };
  },
  policy_decision: (observation, assertion) => {
    const records = matchingRefunds(observation, assertion.refund);
    const record = assertion.occurrence === 'first' ? records[0] : records[-1];
    if (!record) {
      throw new Error('Invalid assertion. Ledger record not found');
    }
    const match = objectsMatch(record.decisionRecord, assertion.expected);
    if (!match) {
      return fail(`Decision records not matching expecting values`);
    }
    return {
      passed: true,
    };
  },
  composed_cap_sum: (observation, assertion) => {
    const cap = observation.declaredPolicy.caps.find(
      (candidate) => candidate.kind === assertion.cap && candidate.currency === assertion.currency,
    );
    if (!cap) {
      return fail(`no declared ${assertion.cap} cap in ${assertion.currency}`);
    }
    // The window floor the ledger would use at the end of the run; a record
    // created exactly at the floor is inside (LedgerQuery.sinceMs).
    const since =
      CAP_REGISTRY[cap.kind].windowed && cap.windowMs !== undefined
        ? observation.clockAtEnd - cap.windowMs
        : undefined;
    const inScope = capScope(assertion);
    const records = observation.ledger.filter(
      (record) =>
        COUNTING_STATUSES.has(record.status) &&
        record.currency === cap.currency &&
        (since === undefined || record.createdAt >= since) &&
        inScope(record),
    );
    const describe = (list: readonly RefundLedgerRecord[]): string =>
      list.map((record) => `${record.id} ${record.status} ${consumed(record)}`).join(', ') ||
      'none';

    if (cap.kind === 'per_call') {
      const over = records.filter((record) => consumed(record) > cap.amountMinorUnits);
      if (over.length === 0) return { passed: true };
      return fail(
        `${over.length} record(s) over the per_call cap of ${cap.amountMinorUnits} ${cap.currency}: ${describe(over)}`,
      );
    }
    const sum = records.reduce((total, record) => total + consumed(record), 0);
    if (sum <= cap.amountMinorUnits) return { passed: true };
    return fail(
      `${cap.kind} sum ${sum} over the declared cap ${cap.amountMinorUnits} ${cap.currency}; counting records: ${describe(records)}`,
    );
  },
  retrieval_verdict: (observation, assertion) => {
    const searchPolicyCalls = toolCallsIn(tracesAt(observation, assertion.at));
    if (!searchPolicyCalls.length) {
      return fail(`No search_policy calls found`);
    }

    const { occurrence } = assertion;
    if (occurrence === 'every') {
      const unexpectedVerdicts = searchPolicyCalls.filter(
        (call) => !checkRetrievalResult(call, assertion.verdict),
      );
      if (unexpectedVerdicts.length) {
        return fail(
          `Unexpected retrieval verdicts: ${unexpectedVerdicts.map((verdict) => `callId ${verdict.callId}, verdict ${(verdict.result as RetrievalResult).verdict}`).join(', ')}`,
        );
      }
      return {
        passed: true,
      };
    }

    const searchPolicyCall =
      occurrence === 'first'
        ? searchPolicyCalls[0]
        : searchPolicyCalls[searchPolicyCalls.length - 1];

    if (!checkRetrievalResult(searchPolicyCall!, assertion.verdict))
      return fail(
        `Unexpected retrieval result. Expected: ${assertion.verdict}, got: ${(searchPolicyCall?.result as RetrievalResult)?.verdict}`,
        searchPolicyCall,
      );
    return {
      passed: true,
    };
  },
  retrieved_sections: (observation, assertion) => {
    const searchPolicyCalls = toolCallsIn(tracesAt(observation, assertion.at));
    if (!searchPolicyCalls.length) {
      return fail(`No search_policy calls found`);
    }

    const matchingRetrievals = searchPolicyCalls.filter((call) => {
      const result = call.result as RetrievalResult;
      const { where } = assertion;
      return result.chunks.some(
        (chunk) =>
          (!where.docId || chunk.docId === where.docId) &&
          (!where.sectionRef || chunk.sectionRef === where.sectionRef) &&
          (!where.tier || chunk.tier === where.tier),
      );
    });

    if (!compare(matchingRetrievals.length, assertion.count)) {
      return fail(
        `Matching retrieval count not matching assertion. Expected: ${JSON.stringify(assertion.count)}, received: ${matchingRetrievals.length}`,
        searchPolicyCalls[0],
      );
    }
    return {
      passed: true,
    };
  },
  reply_contains: (observation, assertion) => {
    const lastTurn = turnSpansIn(tracesAt(observation, assertion.at)).at(-1);
    if (!lastTurn) throw new Error('No turn spans');
    const { outcome } = lastTurn;
    if (!outcome) throw new Error('Turn span has no outcome');
    if (outcome.type !== 'reply') {
      return fail(`Outcome is not a reply: ${outcome.type}`);
    }
    if (assertion.mode === 'all') {
      const stringsNotInResponse = assertion.strings.filter(
        (string) => !outcome.message.includes(string),
      );
      if (stringsNotInResponse.length) {
        return fail(
          `Some of the expected strings are not included in the response: ${stringsNotInResponse.join(', ')}`,
          lastTurn,
        );
      }
    } else if (assertion.mode === 'any') {
      if (!assertion.strings.some((string) => outcome.message.includes(string))) {
        return fail(`None of the expected strings are present in the response.`, lastTurn);
      }
    } else {
      throw new Error(`Unrecognized assertion mode: ${assertion.mode}`);
    }
    return {
      passed: true,
    };
  },
  reply_not_contains: (observation, assertion) => {
    const lastTurn = turnSpansIn(tracesAt(observation, assertion.at)).at(-1);
    if (!lastTurn) throw new Error('No turn spans');
    const { outcome } = lastTurn;
    if (!outcome) throw new Error('Turn span has no outcome');
    if (outcome.type !== 'reply') {
      return fail(`Outcome is not a reply: ${outcome.type}`);
    }
    const stringsContained = assertion.strings.filter((string) => outcome.message.includes(string));
    if (stringsContained.length) {
      fail(`Reply contains unexpected strings: ${stringsContained.join(', ')}`);
    }
    return {
      passed: true,
    };
  },
  turn_outcome: (observation, assertion) => {
    const lastTurn = turnSpansIn(tracesAt(observation, assertion.at)).at(-1);
    if (!lastTurn) throw new Error('No turn spans');
    const { outcome } = lastTurn;
    if (!outcome) throw new Error('Turn span has no outcome');
    if (!objectsMatch(outcome, assertion.expected)) {
      return fail(
        `Unexpected outcome. Expected: ${assertion.expected.type}, got: ${outcome.type}${assertion.expected.type === 'failed' && outcome.type === 'failed' ? `; expected reason: ${assertion.expected.reason}; got: ${outcome.reason}` : ''}`,
      );
    }
    return {
      passed: true,
    };
  },
  no_model_call_after_takeover: (observation, assertion) => {
    const takeOver = observation.takeOvers.find((t) => t.conversation === assertion.conversation);
    if (!takeOver) return fail(`conversation ${assertion.conversation} was never taken over`);
    const after = observation.traces[assertion.conversation - 1]?.slice(takeOver.afterTurn) ?? [];
    const offender = after.find((trace) => trace.spans.some((span) => span.kind === 'model_call'));
    if (offender) {
      return fail(
        `Unexpected model call after conversation takeover`,
        offender.spans.find((span) => span.kind === 'model_call'),
      );
    }
    return {
      passed: true,
    };
  },
};

function turnSpansIn(traces: readonly CompletedTrace[]): CompletedTurnSpanPayload[] {
  return traces
    .flatMap((trace) => trace.spans)
    .filter((span) => span.kind === 'turn')
    .toSorted((a, b) => a.startedAt - b.startedAt);
}

function checkRetrievalResult(
  span: CompletedToolExecutionSpanPayload,
  expected: RetrievalVerdict,
): boolean {
  const result = span.result as RetrievalResult;
  if (!result) throw new Error('Empty retrieval result');
  if (!result.verdict) throw new Error('Retrieval result has no verdict');
  return result.verdict === expected;
}

/** What a record consumes of a cap: the moved amount once known, else the expected one. Mirrors capDecisionFor in core's engine.ts. */
function consumed(record: RefundLedgerRecord): number {
  return record.refundedAmountMinorUnits ?? record.amountMinorUnits;
}

/** Which records a cap kind aggregates over; the schema guarantees the id each scope needs, so a missing one is a bug, not a pass. */
function capScope(
  assertion: AssertionOf<'composed_cap_sum'>,
): (record: RefundLedgerRecord) => boolean {
  switch (assertion.cap) {
    case 'per_order': {
      const { orderId } = assertion;
      if (orderId === undefined) throw new Error('composed_cap_sum: per_order without orderId');
      return (record) => record.orderId === orderId;
    }
    case 'per_customer': {
      if (assertion.email === undefined)
        throw new Error('composed_cap_sum: per_customer without email');
      const key = customerKeyFor({ email: assertion.email });
      return (record) => record.customerKey === key;
    }
    case 'per_call':
    case 'per_day':
      return () => true;
  }
}

function matchingRefunds(
  observation: Observation,
  match: AssertionOf<'ledger_records'>['where'],
): RefundLedgerRecord[] {
  return observation.ledger.filter(
    (rec) =>
      (!match.orderId || rec.orderId === match.orderId) &&
      (!match.orderItemId || rec.orderItemId === match.orderItemId) &&
      (!match.status || match.status.includes(rec.status)) &&
      (match.quantity === undefined || rec.quantity === match.quantity),
  );
}

function fail(reason: string, blameSpan?: CompletedSpanPayload): AssertionResult {
  return {
    passed: false,
    reason,
    ...(blameSpan ? { traceId: blameSpan.traceId } : {}),
  };
}

function compare(a: number, cmp: Count): boolean {
  return (
    (cmp.eq === undefined || a === cmp.eq) &&
    (cmp.gte === undefined || a >= cmp.gte) &&
    (cmp.lte === undefined || a <= cmp.lte)
  );
}

function objectsMatch(obj: Record<string, unknown>, expected: Record<string, unknown>): boolean {
  return Object.entries(expected).every(
    ([key, value]) => key in obj && isDeepStrictEqual(obj[key], value),
  );
}

function tracesAt(observation: Observation, at?: At): readonly CompletedTrace[] {
  if (!at) {
    return observation.timeline;
  }
  if (at.conversation !== undefined) {
    const conversationTraces = observation.traces[at.conversation - 1];
    if (!conversationTraces) {
      throw new Error('Invalid assertion configuration: traces[at.conversation] do not exist');
    }
    if (at.turn !== undefined) {
      const turnTraces = conversationTraces[at.turn - 1];
      if (!turnTraces) {
        throw new Error(
          'Invalid assertion configuration: traces[at.conversation][at.turn] do not exist',
        );
      }
      return [turnTraces];
    }
    return conversationTraces;
  }
  return observation.timeline;
}

function toolCallsIn(
  traces: readonly CompletedTrace[],
  toolName?: ToolName | undefined,
): CompletedToolExecutionSpanPayload[] {
  const toolCalls = traces
    .flatMap((trace) => trace.spans)
    .filter((span) => span.kind === 'tool_execution')
    .toSorted((a, b) => a.startedAt - b.startedAt);
  if (!toolName) {
    return toolCalls;
  }
  return toolCalls.filter((span) => span.toolName === toolName);
}

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
