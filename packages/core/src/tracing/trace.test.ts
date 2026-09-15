// Unit tests for the trace recorder and the OTLP mapper. These run in the
// eval matrix's world: in-process, no Langfuse, no network (ADR 0001). The
// mapper cases pin the wire-format details that broke during development:
// id formats, nanosecond conversion, undefined-dropping, the
// convention-shape message translation (args → arguments), and the
// Langfuse-only `result` copy of tool results.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { Trace } from './trace.js';
import { mapTraceToOTLPEnvelope } from './export/otlp.js';
import type { StartModelCallPayload, TraceConfig } from './types.js';
import type { OtlpSpan } from './export/otlp.js';
import { customerKeyFor } from '../refund-ledger/customer-key.js';
import type { DecisionRecord, PolicyRequest } from '../policy/types.js';

const traceConfig: TraceConfig = {
  sessionId: 'session-1',
  providerName: 'anthropic',
  promptName: 'support-agent',
  promptVersion: 'test-1',
  promptHash: 'cafebabe',
  backendKind: 'demo',
};

const modelCallStart: StartModelCallPayload = {
  promptName: 'support-agent',
  promptVersion: 'test-1',
  promptHash: 'cafebabe',
  providerName: 'anthropic',
  model: 'claude-sonnet-5',
  inputMessages: [{ role: 'user', parts: [{ type: 'text', content: 'Where is my order?' }] }],
};

function recordOneConversation(): Trace {
  const trace = new Trace(traceConfig);
  const turn = trace.startTurnSpan(null, { customerInput: 'Where is my order?' });

  const call = trace.startModelCallSpan(turn.id, modelCallStart);
  call.end({
    inputTokens: 100,
    outputTokens: 20,
    outputMessages: [
      {
        role: 'assistant',
        parts: [
          { type: 'tool_call', id: 'call_1', name: 'lookup_order', args: { orderNumber: '7' } },
        ],
        finishReason: 'tool_use',
      },
    ],
  });

  const tool = trace.startToolExecutionSpan(turn.id, {
    callId: 'call_1',
    toolName: 'lookup_order',
    args: { orderNumber: '7' },
  });
  tool.end({ resultState: 'ok', result: { status: 'shipped' } });

  turn.end({ outcome: { type: 'reply', message: 'It shipped.' } });
  return trace;
}

// A turn whose tool span is never ended. In dev, end() refuses to finalize
// this trace (an open span at trace end is a loop bug); only production may
// end() it, where the sweep records the span as `undetermined`.
function recordConversationWithAbandonedTool(): Trace {
  const trace = new Trace(traceConfig);
  const turn = trace.startTurnSpan(null, { customerInput: 'Where is my order?' });
  trace.startToolExecutionSpan(turn.id, {
    callId: 'call_2',
    toolName: 'get_order_status',
    args: { orderNumber: '7' },
  });
  turn.end({ outcome: { type: 'reply', message: 'It shipped.' } });
  return trace;
}

const policyRequest: PolicyRequest = {
  action: 'issue_refund',
  customerKey: customerKeyFor({ email: 'sam@example.com' }),
  orderId: 'order-1002',
  orderItemId: 'order-1002-line-2',
  quantity: 1,
  currency: 'USD',
  amountMinorUnits: 1200,
};

/** The split-refund verdict: the insoles trip the per-order cap behind the boots. */
const decisionRecord: DecisionRecord = {
  configHash: 'cfg-1',
  request: policyRequest,
  eligibility: [{ ruleKind: 'item_not_delivered', passed: true }],
  perCap: [
    {
      kind: 'per_order',
      currency: 'USD',
      capAmountMinorUnits: 10_000,
      consumedAmountMinorUnits: 8900,
      requestedAmountMinorUnits: 1200,
      remainingBeforeMinorUnits: 1100,
      outcome: 'require_approval',
      contributingRecordIds: ['rec-boots'],
    },
  ],
};

/** A refund turn: the tool consults the engine and the request lands in the queue. */
function recordOneDecision(config: TraceConfig = traceConfig): Trace {
  const trace = new Trace(config);
  const turn = trace.startTurnSpan(null, { customerInput: 'Refund the insoles.' });
  const tool = trace.startToolExecutionSpan(turn.id, {
    callId: 'call_2',
    toolName: 'issue_refund',
    args: { orderId: 'order-1002', orderItemId: 'order-1002-line-2', quantity: 1 },
  });
  const decision = trace.startPolicyDecisionSpan(tool.id, {
    configHash: 'cfg-1',
    request: policyRequest,
  });
  decision.end({ outcome: 'require_approval', reason: 'cap_exceeded', decision: decisionRecord });
  tool.end({ resultState: 'ok', result: { status: 'pending' } });
  turn.end({ outcome: { type: 'reply', message: 'A person will review it.' } });
  return trace;
}

const attr = (span: OtlpSpan, key: string): string | undefined =>
  span.attributes.find((a) => a.key === key)?.value.stringValue;

describe('Trace recorder', () => {
  it('collects all spans in start order with durations stamped', () => {
    const completed = recordOneConversation().end();
    expect(completed.spans.map((s) => s.kind)).toEqual(['turn', 'model_call', 'tool_execution']);
    for (const span of completed.spans) {
      expect(span.duration).toBeGreaterThanOrEqual(0);
      expect(span.traceId).toBe(completed.id);
    }
  });

  describe('unended spans at trace end', () => {
    afterEach(() => {
      vi.unstubAllEnvs();
    });

    it('throws outside production, where an open span at trace end is a loop bug', () => {
      vi.stubEnv('NODE_ENV', 'development');
      const trace = recordConversationWithAbandonedTool();
      expect(() => trace.end()).toThrow(/in_progress/);
    });

    it('sweeps unended spans as undetermined in production, keeps ended ones completed', () => {
      vi.stubEnv('NODE_ENV', 'production');
      const completed = recordConversationWithAbandonedTool().end();
      expect(completed.spans.map((s) => s.status)).toEqual(['completed', 'undetermined']);
    });
  });

  describe('policy_decision spans', () => {
    it('records the consultation under the tool span, start fields beside the end fields', () => {
      const completed = recordOneDecision().end();
      expect(completed.spans.map((s) => s.kind)).toEqual([
        'turn',
        'tool_execution',
        'policy_decision',
      ]);
      const tool = completed.spans[1]!;
      expect(completed.spans[2]).toMatchObject({
        kind: 'policy_decision',
        parentId: tool.id,
        status: 'completed',
        configHash: 'cfg-1',
        request: policyRequest,
        outcome: 'require_approval',
        reason: 'cap_exceeded',
        decision: decisionRecord,
      });
    });

    it('a consultation that errors keeps its config and request', () => {
      const trace = new Trace(traceConfig);
      const turn = trace.startTurnSpan(null, { customerInput: 'refund' });
      const decision = trace.startPolicyDecisionSpan(turn.id, {
        configHash: 'cfg-1',
        request: policyRequest,
      });
      decision.error('decision_failed');
      turn.end({ outcome: { type: 'failed', reason: 'internal' } });
      const span = trace.end().spans[1];
      expect(span).toMatchObject({
        kind: 'policy_decision',
        status: 'error',
        errorType: 'decision_failed',
        configHash: 'cfg-1',
        request: policyRequest,
      });
      expect(span).not.toHaveProperty('outcome');
    });
  });

  it('records the customer-visible turn boundary', () => {
    const completed = recordOneConversation().end();
    const turn = completed.spans.find((s) => s.kind === 'turn');
    expect(turn).toMatchObject({
      customerInput: 'Where is my order?',
      outcome: { type: 'reply', message: 'It shipped.' },
    });
  });

  it('first completion wins: end after error does not overwrite', () => {
    const trace = new Trace(traceConfig);
    const call = trace.startModelCallSpan(null, modelCallStart);
    call.error('timeout');
    call.end({ inputTokens: 1, outputTokens: 1, outputMessages: [] });
    const [span] = trace.end().spans;
    expect(span).toMatchObject({ status: 'error', errorType: 'timeout' });
    expect(span).not.toHaveProperty('outputMessages');
  });

  it('end() is idempotent and freezes the trace', () => {
    const trace = recordOneConversation();
    const first = trace.end();
    const second = trace.end();
    expect(second).toBe(first);
    expect(first.spans).toHaveLength(3);
  });

  describe('starting a span after end()', () => {
    afterEach(() => {
      vi.unstubAllEnvs();
    });

    it('throws outside production, where an agent-loop bug should be loud', () => {
      vi.stubEnv('NODE_ENV', 'development');
      const trace = recordOneConversation();
      trace.end();
      expect(() => trace.startTurnSpan(null, { customerInput: 'late arrival' })).toThrow(
        /after end\(\)/,
      );
    });

    it('is silently dropped in production: tracing never breaks a live conversation', () => {
      vi.stubEnv('NODE_ENV', 'production');
      const trace = recordOneConversation();
      const first = trace.end();
      trace.startTurnSpan(null, { customerInput: 'late arrival' });
      expect(trace.end()).toBe(first);
      expect(first.spans).toHaveLength(3);
    });
  });
});

describe('OTLP mapper', () => {
  const completed = recordOneConversation().end();
  const spans = mapTraceToOTLPEnvelope(completed).resourceSpans[0]!.scopeSpans[0]!.spans;

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('emits OTel-valid ids and preserves parenthood', () => {
    for (const span of spans) {
      expect(span.traceId).toMatch(/^[0-9a-f]{32}$/);
      expect(span.spanId).toMatch(/^[0-9a-f]{16}$/);
    }
    const turn = spans.find((s) => s.name === 'turn')!;
    const children = spans.filter((s) => s.name !== 'turn');
    for (const child of children) {
      expect(child.parentSpanId).toBe(turn.spanId);
    }
  });

  it('emits the policy decision as kept.* attributes and Langfuse panes, under the tool span', () => {
    const decided = mapTraceToOTLPEnvelope(recordOneDecision().end()).resourceSpans[0]!
      .scopeSpans[0]!.spans;
    const tool = decided.find((s) => s.name === 'tool_execution')!;
    const decision = decided.find((s) => s.name === 'policy_decision')!;

    expect(decision.parentSpanId).toBe(tool.spanId);
    expect(decision.status.code).toBe(1);
    expect(attr(decision, 'kept.policy.action')).toBe('issue_refund');
    expect(attr(decision, 'kept.policy.outcome')).toBe('require_approval');
    expect(attr(decision, 'kept.policy.reason')).toBe('cap_exceeded');
    expect(attr(decision, 'kept.policy.config_hash')).toBe('cfg-1');
    expect(JSON.parse(attr(decision, 'kept.policy.request')!)).toEqual(policyRequest);
    expect(JSON.parse(attr(decision, 'kept.policy.decision')!)).toEqual(decisionRecord);
    expect(JSON.parse(attr(decision, 'langfuse.observation.input')!)).toEqual(policyRequest);
    expect(JSON.parse(attr(decision, 'langfuse.observation.output')!)).toEqual({
      outcome: 'require_approval',
      reason: 'cap_exceeded',
      decision: decisionRecord,
    });
    expect(attr(decision, 'langfuse.observation.metadata.outcomeType')).toBe('require_approval');
    expect(attr(decision, 'langfuse.observation.metadata.outcomeReason')).toBe('cap_exceeded');
    expect(attr(decision, 'gen_ai.operation.name')).toBeUndefined();
  });

  it('stamps the policy config hash on every span only when the trace carries one', () => {
    const key = 'langfuse.trace.metadata.policyConfigHash';
    const stamped = mapTraceToOTLPEnvelope(
      recordOneDecision({ ...traceConfig, policyConfigHash: 'cfg-1' }).end(),
    ).resourceSpans[0]!.scopeSpans[0]!.spans;
    for (const span of stamped) {
      expect(attr(span, key)).toBe('cfg-1');
    }
    for (const span of spans) {
      expect(span.attributes.map((a) => a.key)).not.toContain(key);
    }
  });

  it('converts wall-clock milliseconds to nanosecond strings', () => {
    for (const span of spans) {
      const start = BigInt(span.startTimeUnixNano);
      const end = BigInt(span.endTimeUnixNano);
      // A current epoch-ms timestamp in nanos is ~1.7e18; ms would be ~1.7e12.
      expect(start).toBeGreaterThan(10n ** 17n);
      expect(end).toBeGreaterThanOrEqual(start);
    }
  });

  it('translates messages to the convention shape (args → arguments)', () => {
    const generation = spans.find((s) => s.name === 'model_call')!;
    const output = generation.attributes.find((a) => a.key === 'langfuse.observation.output')!;
    const messages = JSON.parse(output.value.stringValue!);
    expect(messages[0].finish_reason).toBe('tool_use');
    expect(messages[0].parts[0]).toMatchObject({
      type: 'tool_call',
      id: 'call_1',
      arguments: { orderNumber: '7' },
    });
    expect(messages[0].parts[0]).not.toHaveProperty('args');
  });

  it('gives the Langfuse copy of a tool result a `result` key and keeps the OTel copy pure', () => {
    // A second-round model call: its input carries the tool result the
    // model was answering. The Langfuse UI reads that text from `result`;
    // the convention has only `response`.
    const trace = new Trace(traceConfig);
    const turn = trace.startTurnSpan(null, { customerInput: 'Where is my order?' });
    const call = trace.startModelCallSpan(turn.id, {
      ...modelCallStart,
      inputMessages: [
        ...modelCallStart.inputMessages,
        {
          role: 'assistant',
          parts: [
            { type: 'tool_call', id: 'call_1', name: 'lookup_order', args: { orderNumber: '7' } },
          ],
        },
        {
          role: 'user',
          parts: [
            {
              type: 'tool_call_response',
              id: 'call_1',
              response: '{"status":"shipped"}',
              status: 'ok',
            },
          ],
        },
      ],
    });
    call.end({ inputTokens: 1, outputTokens: 1, outputMessages: [] });
    turn.end({ outcome: { type: 'reply', message: 'It shipped.' } });

    const generation = mapTraceToOTLPEnvelope(
      trace.end(),
    ).resourceSpans[0]!.scopeSpans[0]!.spans.find((s) => s.name === 'model_call')!;
    const partsOf = (key: string): unknown[] => {
      const attribute = generation.attributes.find((a) => a.key === key)!;
      return JSON.parse(attribute.value.stringValue!)[2].parts;
    };

    expect(partsOf('langfuse.observation.input')[0]).toEqual({
      type: 'tool_call_response',
      id: 'call_1',
      response: '{"status":"shipped"}',
      result: '{"status":"shipped"}',
    });
    expect(partsOf('gen_ai.input.messages')[0]).toEqual({
      type: 'tool_call_response',
      id: 'call_1',
      response: '{"status":"shipped"}',
    });
  });

  it('emits the turn preview and outcome type', () => {
    const turn = spans.find((s) => s.name === 'turn')!;
    const byKey = Object.fromEntries(turn.attributes.map((a) => [a.key, a.value]));
    expect(byKey['langfuse.observation.input']).toEqual({ stringValue: 'Where is my order?' });
    expect(byKey['langfuse.observation.output']).toEqual({ stringValue: 'It shipped.' });
    expect(byKey['langfuse.observation.metadata.outcomeType']).toEqual({ stringValue: 'reply' });
    expect(byKey['gen_ai.operation.name']).toBeUndefined();
  });

  it('maps the swept span to an error status without inventing an output', () => {
    // Sweeping only happens in production; in dev the same trace refuses to end().
    vi.stubEnv('NODE_ENV', 'production');
    const swept = mapTraceToOTLPEnvelope(recordConversationWithAbandonedTool().end())
      .resourceSpans[0]!.scopeSpans[0]!.spans;
    const abandoned = swept.find((s) =>
      s.attributes.some((a) => a.value.stringValue === 'call_2'),
    )!;
    expect(abandoned.status).toEqual({ code: 2, message: 'undetermined' });
    const keys = abandoned.attributes.map((a) => a.key);
    expect(keys).not.toContain('langfuse.observation.output');
  });

  it('never emits an attribute without a defined value', () => {
    for (const span of spans) {
      for (const attribute of span.attributes) {
        const scalars = Object.values(attribute.value);
        expect(scalars.some((v) => v !== undefined)).toBe(true);
      }
    }
  });
});
