// OpenAIModelClient tests: shared contract against a fetch-level fake of the
// Chat Completions wire format, plus request-shape assertions for the parts
// that differ from Anthropic (system-as-message, per-call tool messages,
// stringified arguments, max_completion_tokens).

import { describe, expect, it } from 'vitest';
import { OpenAIModelClient } from './openai.js';
import {
  contractReplyText,
  contractCustomerTurn,
  contractToolCalls,
  describeModelClientContract,
  type ModelClientScenario,
} from './client.contract.js';
import { toModelToolRegistry } from './utils.js';
import { createToolRegistry } from '../tools/registry.js';
import type { ModelClientConfig } from './types.js';
import type { Message } from '../messages.js';
import type { OrderBackend } from '../backend/order-backend.js';

const unreachableBackend: OrderBackend = {
  findOrder: () => {
    throw new Error('model-client tests must never execute tools');
  },
};

const config: ModelClientConfig = {
  provider: 'openai',
  model: 'gpt-test',
  maxTokens: 512,
  promptData: {
    name: 'main-agent',
    version: '1.0.0',
    hash: 'cafebabe',
    text: 'You are a post-purchase support agent.',
  },
  toolRegistry: toModelToolRegistry(createToolRegistry(unreachableBackend)),
};

// --- Wire fixtures ----------------------------------------------------------

function wireCompletion(
  messageOverrides: Record<string, unknown> = {},
  finishReason = 'stop',
): Record<string, unknown> {
  return {
    id: 'chatcmpl-1',
    object: 'chat.completion',
    created: 1,
    model: config.model,
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: contractReplyText,
          refusal: null,
          ...messageOverrides,
        },
        finish_reason: finishReason,
        logprobs: null,
      },
    ],
    usage: { prompt_tokens: 120, completion_tokens: 45, total_tokens: 165 },
  };
}

const wireToolCalls = contractToolCalls.map((call) => ({
  id: call.id,
  type: 'function',
  function: { name: call.name, arguments: JSON.stringify(call.args) },
}));

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function apiError(status: number, body: Record<string, unknown>): Response {
  return jsonResponse({ error: body }, status);
}

type FetchLike = (url: string | URL | Request, init?: RequestInit) => Promise<Response>;

const scenarioFetch: Record<ModelClientScenario, FetchLike> = {
  replies_with_text: async () => jsonResponse(wireCompletion()),
  requests_parallel_tools: async () =>
    jsonResponse(wireCompletion({ content: null, tool_calls: wireToolCalls }, 'tool_calls')),
  hits_max_tokens: async () => jsonResponse(wireCompletion({}, 'length')),
  refuses: async () => jsonResponse(wireCompletion({ content: null }, 'content_filter')),
  unknown_stop_reason: async () => jsonResponse(wireCompletion({}, 'function_call')),
  context_overflow_request: async () =>
    apiError(400, {
      message: "This model's maximum context length is 128000 tokens.",
      type: 'invalid_request_error',
      param: 'messages',
      code: 'context_length_exceeded',
    }),
  // OpenAI has no mid-generation overflow stop reason; marked unsupported below.
  context_overflow_generation: async () => jsonResponse(wireCompletion()),
  // Never settles on its own, but honors the SDK's timeout abort — a fetch
  // that ignores the signal would hang the SDK's timeout machinery too.
  times_out: (_url, init) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () =>
        reject(new DOMException('The operation was aborted.', 'AbortError')),
      );
    }),
  server_error: async () =>
    apiError(500, { message: 'internal', type: 'server_error', param: null, code: null }),
  network_failure: async () => {
    throw new TypeError('fetch failed');
  },
};

function makeClient(scenario: ModelClientScenario): OpenAIModelClient {
  return new OpenAIModelClient(config, 'test-key', {
    fetch: scenarioFetch[scenario],
    maxRetries: 0,
    ...(scenario === 'times_out' ? { timeout: 50 } : {}),
  });
}

describeModelClientContract('openai', {
  makeClient,
  unsupported: ['context_overflow_generation'],
});

// --- Request-shape assertions ----------------------------------------------

function makeCapturingClient(): {
  client: OpenAIModelClient;
  body: () => Record<string, unknown>;
} {
  let captured: Record<string, unknown> | undefined;
  const client = new OpenAIModelClient(config, 'test-key', {
    maxRetries: 0,
    fetch: async (_url, init) => {
      captured = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return jsonResponse(wireCompletion());
    },
  });
  return { client, body: () => captured! };
}

describe('OpenAIModelClient request shape', () => {
  it('sends the system prompt as the first message and uses max_completion_tokens', async () => {
    const { client, body } = makeCapturingClient();
    await client.callModel(contractCustomerTurn);
    expect(body()).toMatchObject({ model: 'gpt-test', max_completion_tokens: 512 });
    const messages = body()['messages'] as Record<string, unknown>[];
    expect(messages[0]).toEqual({
      role: 'system',
      content: 'You are a post-purchase support agent.',
    });
  });

  it('sends tools in function wrapper shape with the JSON Schema as parameters', async () => {
    const { client, body } = makeCapturingClient();
    await client.callModel(contractCustomerTurn);
    const tools = body()['tools'] as Record<string, unknown>[];
    expect(tools).toHaveLength(1);
    expect(tools[0]).toEqual({
      type: 'function',
      function: {
        name: 'lookup_order',
        description: 'Use to find customer order',
        parameters: expect.objectContaining({
          type: 'object',
          properties: { orderId: expect.objectContaining({ type: 'string' }) },
          required: ['orderId'],
        }),
      },
    });
  });

  it('fans one internal tool-result message out into per-call tool messages, before any text', async () => {
    const history: Message[] = [
      { role: 'user', parts: [{ type: 'text', content: 'Check both orders.' }] },
      {
        role: 'assistant',
        parts: [
          {
            type: 'tool_call',
            id: 'call-1',
            name: 'lookup_order',
            args: { orderId: 'order-1001' },
          },
          {
            type: 'tool_call',
            id: 'call-2',
            name: 'lookup_order',
            args: { orderId: 'order-1002' },
          },
        ],
      },
      {
        role: 'user',
        parts: [
          { type: 'tool_call_response', id: 'call-1', response: 'shipped', status: 'ok' },
          { type: 'tool_call_response', id: 'call-2', response: 'pending', status: 'ok' },
          { type: 'text', content: 'Thanks!' },
        ],
      },
    ];
    const { client, body } = makeCapturingClient();
    await client.callModel(history);
    const messages = body()['messages'] as Record<string, unknown>[];
    expect(messages).toEqual([
      { role: 'system', content: 'You are a post-purchase support agent.' },
      { role: 'user', content: 'Check both orders.' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'call-1',
            type: 'function',
            function: { name: 'lookup_order', arguments: '{"orderId":"order-1001"}' },
          },
          {
            id: 'call-2',
            type: 'function',
            function: { name: 'lookup_order', arguments: '{"orderId":"order-1002"}' },
          },
        ],
      },
      { role: 'tool', tool_call_id: 'call-1', content: 'shipped' },
      { role: 'tool', tool_call_id: 'call-2', content: 'pending' },
      { role: 'user', content: 'Thanks!' },
    ]);
  });

  it('contains malformed tool arguments as empty args instead of throwing', async () => {
    const client = new OpenAIModelClient(config, 'test-key', {
      maxRetries: 0,
      fetch: async () =>
        jsonResponse(
          wireCompletion(
            {
              content: null,
              tool_calls: [
                {
                  id: 'call-bad',
                  type: 'function',
                  function: { name: 'lookup_order', arguments: '{"orderId": order-' },
                },
              ],
            },
            'tool_calls',
          ),
        ),
    });
    const result = await client.callModel(contractCustomerTurn);
    expect(result.type).toBe('tool_use');
    if (result.type !== 'tool_use') return;
    expect(result.message.parts).toEqual([
      { type: 'tool_call', id: 'call-bad', name: 'lookup_order', args: {} },
    ]);
  });

  it('classifies a message-level refusal as refusal even when finish_reason is stop', async () => {
    const client = new OpenAIModelClient(config, 'test-key', {
      maxRetries: 0,
      fetch: async () =>
        jsonResponse(
          wireCompletion({ content: null, refusal: 'I cannot help with that.' }, 'stop'),
        ),
    });
    const result = await client.callModel(contractCustomerTurn);
    expect(result.type).toBe('refusal');
    if (result.type !== 'refusal') return;
    expect(result.message.parts).toEqual([{ type: 'text', content: 'I cannot help with that.' }]);
  });

  it('surfaces an illegal role in history as transport_error, not a throw', async () => {
    const { client } = makeCapturingClient();
    // MessageRole makes this unrepresentable at compile time; the cast
    // simulates history deserialized from storage, where types can't vouch.
    const corrupted = [
      { role: 'tool', parts: [{ type: 'text', content: 'smuggled' }] },
    ] as unknown as Message[];
    const result = await client.callModel(corrupted);
    expect(result).toMatchObject({ type: 'transport_error', errorType: '_OTHER' });
  });
});
