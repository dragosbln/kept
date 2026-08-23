// Unit tests for the trace recorder and the OTLP mapper. These run in the
// eval matrix's world: in-process, no Langfuse, no network (ADR 0001). The
// mapper cases pin the wire-format details that broke during development:
// id formats, nanosecond conversion, undefined-dropping, and the
// convention-shape message translation (args → arguments).

import { afterEach, describe, expect, it, vi } from 'vitest';
import { Trace } from './trace.js';
import { mapTraceToOTLPEnvelope } from './export/otlp.js';
import type { StartModelCallPayload, TraceConfig } from './types.js';

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
  topK: 40,
  temperature: 0.2,
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

  // Started, never ended: must be swept as `undetermined`.
  trace.startToolExecutionSpan(turn.id, {
    callId: 'call_2',
    toolName: 'get_order_status',
    args: { orderNumber: '7' },
  });

  turn.end({ outcome: { type: 'reply', message: 'It shipped.' } });
  return trace;
}

describe('Trace recorder', () => {
  it('collects all spans in start order with durations stamped', () => {
    const completed = recordOneConversation().end();
    expect(completed.spans.map((s) => s.kind)).toEqual([
      'turn',
      'model_call',
      'tool_execution',
      'tool_execution',
    ]);
    for (const span of completed.spans) {
      expect(span.duration).toBeGreaterThanOrEqual(0);
      expect(span.traceId).toBe(completed.id);
    }
  });

  it('sweeps unended spans as undetermined, keeps ended ones completed', () => {
    const completed = recordOneConversation().end();
    const statuses = completed.spans.map((s) => s.status);
    expect(statuses).toEqual(['completed', 'completed', 'completed', 'undetermined']);
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
    expect(first.spans).toHaveLength(4);
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
      expect(first.spans).toHaveLength(4);
    });
  });
});

describe('OTLP mapper', () => {
  const completed = recordOneConversation().end();
  const spans = mapTraceToOTLPEnvelope(completed).resourceSpans[0]!.scopeSpans[0]!.spans;

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

  it('emits the turn preview and outcome type', () => {
    const turn = spans.find((s) => s.name === 'turn')!;
    const byKey = Object.fromEntries(turn.attributes.map((a) => [a.key, a.value]));
    expect(byKey['langfuse.observation.input']).toEqual({ stringValue: 'Where is my order?' });
    expect(byKey['langfuse.observation.output']).toEqual({ stringValue: 'It shipped.' });
    expect(byKey['langfuse.observation.metadata.outcomeType']).toEqual({ stringValue: 'reply' });
    expect(byKey['gen_ai.operation.name']).toBeUndefined();
  });

  it('maps the swept span to an error status without inventing an output', () => {
    const abandoned = spans.find((s) =>
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
