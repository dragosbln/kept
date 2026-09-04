// State-machine tests for runTurn, driven by a scripted ModelClient fake and
// asserted three ways per the ADR-0001 pattern: the outcome (what the
// customer sees), the history (what persists — atomic: only a reply commits
// the turn), and the in-process trace (what really happened). This file is
// the dress rehearsal for the eval runner: every assertion here reads the
// same CompletedTrace model eval assertions will.
//
// Tools are real: the registry runs against the seeded DemoBackend, so tool
// rounds exercise registry → executor → backend end to end.

import { describe, expect, it, vi } from 'vitest';
import { runTurn } from './loop.js';
import { Trace } from '../tracing/trace.js';
import type { CompletedTrace, TraceConfig } from '../tracing/types.js';
import { createToolRegistry } from '../tools/registry.js';
import { DemoBackend } from '../backend/demo.js';
import { makeDemoOrders } from '../backend/seed-orders.js';
import type { ModelClient } from '../model/client.js';
import type { CallModelResponse, ModelClientConfig } from '../model/types.js';
import type { Message, ToolArgs } from '../messages.js';
import type { Conversation } from '../conversation/types.js';
import type { RunTurnResult } from './types.js';

// --- Fixtures ---------------------------------------------------------------

const fakeConfig: ModelClientConfig = {
  provider: 'anthropic',
  model: 'fake-model',
  maxTokens: 512,
  promptData: { name: 'main-agent', version: '1.0.0', hash: 'cafebabe', text: 'You are Kept.' },
  toolRegistry: [],
};

const traceConfig: TraceConfig = {
  sessionId: 'conv-1',
  providerName: 'anthropic',
  promptName: 'main-agent',
  promptVersion: '1.0.0',
  promptHash: 'cafebabe',
  backendKind: 'demo',
};

/** Plays back a fixed script of responses; records what each call received. */
class FakeModelClient implements ModelClient {
  readonly calls: Message[][] = [];
  private script: CallModelResponse[];

  constructor(script: CallModelResponse[]) {
    this.script = [...script];
  }

  async callModel(messages: Message[]): Promise<CallModelResponse> {
    this.calls.push(messages);
    const next = this.script.shift();
    if (!next) throw new Error('FakeModelClient: script exhausted — test bug');
    return next;
  }

  getConfig(): Readonly<ModelClientConfig> {
    return fakeConfig;
  }
}

const usage = { inputTokens: 10, outputTokens: 5 };

function endTurn(text: string): CallModelResponse {
  return {
    type: 'end_turn',
    message: { role: 'assistant', parts: [{ type: 'text', content: text }] },
    usage,
  };
}

function toolUse(calls: { id: string; name: string; args: ToolArgs }[]): CallModelResponse {
  return {
    type: 'tool_use',
    message: {
      role: 'assistant',
      parts: calls.map((call) => ({
        type: 'tool_call' as const,
        id: call.id,
        name: call.name,
        args: call.args,
      })),
    },
    usage,
  };
}

const registry = createToolRegistry(new DemoBackend(makeDemoOrders()));

function emptyConversation(): Conversation {
  return { id: 'conv-1', messages: [] };
}

type RunReturnType = {
  trace: Trace;
  modelClient: FakeModelClient;
  promise: Promise<RunTurnResult>;
};

function run(script: CallModelResponse[], overrides: { maxRounds?: number } = {}): RunReturnType {
  const trace = new Trace(traceConfig);
  const modelClient = new FakeModelClient(script);
  const promise = runTurn({
    conversation: emptyConversation(),
    message: 'Where is my order?',
    modelClient,
    tools: registry,
    trace,
    ...overrides,
  });
  return { trace, modelClient, promise };
}

function spanKinds(completed: CompletedTrace): string[] {
  return completed.spans.map((span) => span.kind);
}

function expectAllSpansSettled(completed: CompletedTrace): void {
  // 'undetermined' would mean the loop left a span open for the sweep to catch.
  for (const span of completed.spans) {
    expect(span.status, `span ${span.kind}`).not.toBe('undetermined');
  }
}

// --- Terminals --------------------------------------------------------------

describe('runTurn', () => {
  it('replied: plain reply commits the turn to history and closes both spans', async () => {
    const { trace, promise } = run([endTurn('It shipped.')]);
    const result = await promise;

    expect(result.outcome).toEqual({ type: 'reply', message: 'It shipped.' });
    expect(result.updatedHistory).toEqual([
      { role: 'user', parts: [{ type: 'text', content: 'Where is my order?' }] },
      { role: 'assistant', parts: [{ type: 'text', content: 'It shipped.' }] },
    ]);

    const completed = trace.end();
    expect(spanKinds(completed)).toEqual(['turn', 'model_call']);
    expectAllSpansSettled(completed);
    const [turn, call] = completed.spans;
    expect(turn).toMatchObject({
      kind: 'turn',
      status: 'completed',
      parentId: null,
      customerInput: 'Where is my order?',
      outcome: { type: 'reply', message: 'It shipped.' },
    });
    expect(call).toMatchObject({
      kind: 'model_call',
      status: 'completed',
      parentId: turn!.id,
      inputTokens: 10,
      outputTokens: 5,
      promptHash: 'cafebabe',
    });
  });

  it('tool round-trip: executes the real tool, answers in one user message, keeps email out', async () => {
    const { trace, modelClient, promise } = run([
      toolUse([{ id: 'call-1', name: 'lookup_order', args: { orderId: 'order-1001' } }]),
      endTurn('Your order shipped.'),
    ]);
    const result = await promise;

    expect(result.outcome).toEqual({ type: 'reply', message: 'Your order shipped.' });
    expect(result.updatedHistory).toHaveLength(4);
    const [, assistantMsg, toolResultMsg] = result.updatedHistory;
    expect(assistantMsg!.parts).toEqual([
      { type: 'tool_call', id: 'call-1', name: 'lookup_order', args: { orderId: 'order-1001' } },
    ]);
    expect(toolResultMsg!.role).toBe('user');
    expect(toolResultMsg!.parts).toHaveLength(1);
    expect(toolResultMsg!.parts[0]).toMatchObject({
      type: 'tool_call_response',
      id: 'call-1',
      status: 'ok',
    });
    const response = (toolResultMsg!.parts[0] as { response: string }).response;
    expect(response).toContain('order-1001');
    expect(response).not.toContain('dana@example.com'); // sanitization holds through the loop

    // The second model call saw the full round: user, assistant, tool results.
    expect(modelClient.calls).toHaveLength(2);
    expect(modelClient.calls[1]).toHaveLength(3);

    const completed = trace.end();
    expect(spanKinds(completed)).toEqual(['turn', 'model_call', 'tool_execution', 'model_call']);
    expectAllSpansSettled(completed);
    const toolSpan = completed.spans.find((span) => span.kind === 'tool_execution');
    expect(toolSpan).toMatchObject({
      status: 'completed',
      callId: 'call-1',
      toolName: 'lookup_order',
      resultState: 'ok',
      parentId: completed.spans[0]!.id, // contained by the turn, not the model call
    });
  });

  it('parallel tools: all results land in a single user message, one span per call', async () => {
    const { trace, promise } = run([
      toolUse([
        { id: 'call-1', name: 'lookup_order', args: { orderId: 'order-1001' } },
        { id: 'call-2', name: 'lookup_order', args: { orderId: 'order-1002' } },
      ]),
      endTurn('Both looked up.'),
    ]);
    const result = await promise;

    const toolResultMsg = result.updatedHistory[2]!;
    expect(toolResultMsg.role).toBe('user');
    expect(toolResultMsg.parts.map((part) => (part as { id: string }).id)).toEqual([
      'call-1',
      'call-2',
    ]);

    const completed = trace.end();
    expect(completed.spans.filter((span) => span.kind === 'tool_execution')).toHaveLength(2);
    expectAllSpansSettled(completed);
  });

  it('a model-invented tool name settles as failed and the turn continues', async () => {
    const { trace, promise } = run([
      toolUse([{ id: 'call-1', name: 'issue_refund', args: { amount: 9999 } }]),
      endTurn('I cannot do that yet.'),
    ]);
    const result = await promise;

    expect(result.outcome.type).toBe('reply');
    expect(result.updatedHistory[2]!.parts[0]).toMatchObject({
      type: 'tool_call_response',
      id: 'call-1',
      status: 'failed',
    });

    const completed = trace.end();
    const toolSpan = completed.spans.find((span) => span.kind === 'tool_execution');
    expect(toolSpan).toMatchObject({ resultState: 'failed', toolName: 'issue_refund' });
  });

  it('max_rounds: stops at the round budget without executing the doomed round', async () => {
    const { trace, promise } = run(
      [
        toolUse([{ id: 'call-1', name: 'lookup_order', args: { orderId: 'order-1001' } }]),
        toolUse([{ id: 'call-2', name: 'lookup_order', args: { orderId: 'order-1002' } }]),
      ],
      { maxRounds: 1 },
    );
    const result = await promise;

    expect(result.outcome).toEqual({ type: 'failed', reason: 'max_rounds' });
    expect(result.updatedHistory).toEqual([]); // atomic: nothing persists

    const completed = trace.end();
    // Round 1's tool ran; the over-budget round's tool did NOT.
    expect(completed.spans.filter((span) => span.kind === 'tool_execution')).toHaveLength(1);
    expectAllSpansSettled(completed);
  });

  it('transport_error: failed(internal), pre-turn history, model-call span errored', async () => {
    const { trace, promise } = run([
      { type: 'transport_error', errorType: '500', error: new Error('boom') },
    ]);
    const result = await promise;

    expect(result.outcome).toEqual({ type: 'failed', reason: 'internal' });
    expect(result.updatedHistory).toEqual([]);

    const completed = trace.end();
    expectAllSpansSettled(completed);
    const call = completed.spans.find((span) => span.kind === 'model_call');
    expect(call).toMatchObject({ status: 'error', errorType: '500' });
    const turn = completed.spans.find((span) => span.kind === 'turn');
    // Turns never error(): they complete with a failed outcome.
    expect(turn).toMatchObject({
      status: 'completed',
      outcome: { type: 'failed', reason: 'internal' },
    });
  });

  it('refusal: failed(refusal), nothing persisted, content preserved in the trace', async () => {
    const refusalMessage: Message = {
      role: 'assistant',
      parts: [{ type: 'text', content: 'I cannot help with that.' }],
    };
    const { trace, promise } = run([{ type: 'refusal', message: refusalMessage, usage }]);
    const result = await promise;

    expect(result.outcome).toEqual({ type: 'failed', reason: 'refusal' });
    expect(result.updatedHistory).toEqual([]);

    const call = trace.end().spans.find((span) => span.kind === 'model_call');
    expect(call).toMatchObject({ status: 'completed', outputMessages: [refusalMessage] });
  });

  it('max_tokens: failed(max_tokens), pre-turn history', async () => {
    const { promise } = run([
      {
        type: 'max_tokens',
        message: { role: 'assistant', parts: [{ type: 'text', content: 'truncat' }] },
        usage,
      },
    ]);
    const result = await promise;
    expect(result.outcome).toEqual({ type: 'failed', reason: 'max_tokens' });
    expect(result.updatedHistory).toEqual([]);
  });

  it('unknown stop reason: failed(unknown_stop_reason), pre-turn history', async () => {
    const { promise } = run([
      {
        type: 'unknown',
        stopReason: 'pause_turn',
        message: { role: 'assistant', parts: [] },
        usage,
      },
    ]);
    const result = await promise;
    expect(result.outcome).toEqual({ type: 'failed', reason: 'unknown_stop_reason' });
    expect(result.updatedHistory).toEqual([]);
  });

  it('conversation_full (request flavor): outcome only, span errored, nothing persisted', async () => {
    const { trace, promise } = run([{ type: 'context_window_exceeded' }]);
    const result = await promise;

    expect(result.outcome).toEqual({ type: 'conversation_full' });
    expect(result.updatedHistory).toEqual([]);

    const call = trace.end().spans.find((span) => span.kind === 'model_call');
    expect(call).toMatchObject({ status: 'error', errorType: 'context_window_exceeded' });
  });

  it('conversation_full (generation flavor): the truncated partial is recorded in the trace', async () => {
    const partial: Message = { role: 'assistant', parts: [{ type: 'text', content: 'half an' }] };
    const { trace, promise } = run([{ type: 'context_window_exceeded', message: partial, usage }]);
    const result = await promise;

    expect(result.outcome).toEqual({ type: 'conversation_full' });
    expect(result.updatedHistory).toEqual([]);

    const call = trace.end().spans.find((span) => span.kind === 'model_call');
    expect(call).toMatchObject({ status: 'completed', outputMessages: [partial] });
  });

  it('an end_turn with no text becomes failed(empty_reply), never an empty reply', async () => {
    const { promise } = run([
      { type: 'end_turn', message: { role: 'assistant', parts: [] }, usage },
    ]);
    const result = await promise;
    expect(result.outcome).toEqual({ type: 'failed', reason: 'empty_reply' });
    expect(result.updatedHistory).toEqual([]);
  });

  it('prior history rides along: the model sees it, and a reply appends to it', async () => {
    const prior: Message[] = [
      { role: 'user', parts: [{ type: 'text', content: 'Hi.' }] },
      { role: 'assistant', parts: [{ type: 'text', content: 'Hello! How can I help?' }] },
    ];
    const trace = new Trace(traceConfig);
    const modelClient = new FakeModelClient([endTurn('It shipped.')]);
    const result = await runTurn({
      conversation: { id: 'conv-1', messages: prior },
      message: 'Where is my order?',
      modelClient,
      tools: registry,
      trace,
    });

    expect(modelClient.calls[0]).toHaveLength(3); // prior 2 + new customer message
    expect(result.updatedHistory).toHaveLength(4);
    expect(result.updatedHistory.slice(0, 2)).toEqual(prior);
  });

  it('contains a contract-violating client: failed(internal), turn span still closed', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const throwingClient: ModelClient = {
        callModel: async () => {
          throw new Error('client broke its never-rejects contract');
        },
        getConfig: () => fakeConfig,
      };
      const trace = new Trace(traceConfig);
      const result = await runTurn({
        conversation: emptyConversation(),
        message: 'Where is my order?',
        modelClient: throwingClient,
        tools: registry,
        trace,
      });

      expect(result.outcome).toEqual({ type: 'failed', reason: 'internal' });
      expect(result.updatedHistory).toEqual([]);

      // In dev mode an unfinished turn span makes trace.end() throw — so this
      // both must not throw AND must show the turn span completed.
      const completed = trace.end();
      const turn = completed.spans.find((span) => span.kind === 'turn');
      expect(turn).toMatchObject({
        status: 'completed',
        outcome: { type: 'failed', reason: 'internal' },
      });
      expect(consoleSpy).toHaveBeenCalled();
    } finally {
      consoleSpy.mockRestore();
    }
  });
});
