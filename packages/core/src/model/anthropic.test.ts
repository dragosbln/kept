// AnthropicModelClient tests: the shared contract run against a fetch-level
// fake of the Anthropic wire format, plus provider-specific request-shape
// assertions (what this client actually sends). Faking at the fetch layer
// exercises the real SDK parse path — response classification is tested
// through the same machinery production traffic uses.

import { describe, expect, it } from 'vitest';
import { AnthropicModelClient } from './anthropic.js';
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
  provider: 'anthropic',
  model: 'claude-sonnet-5',
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

function wireMessage(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'msg_01',
    type: 'message',
    role: 'assistant',
    model: config.model,
    content: [{ type: 'text', text: contractReplyText }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 120, output_tokens: 45 },
    ...overrides,
  };
}

const toolUseContent = contractToolCalls.map((call) => ({
  type: 'tool_use',
  id: call.id,
  name: call.name,
  input: call.args,
}));

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function apiError(status: number, type: string, message: string): Response {
  return jsonResponse({ type: 'error', error: { type, message } }, status);
}

type FetchLike = (url: string | URL | Request, init?: RequestInit) => Promise<Response>;

const scenarioFetch: Record<ModelClientScenario, FetchLike> = {
  replies_with_text: async () => jsonResponse(wireMessage()),
  requests_parallel_tools: async () =>
    jsonResponse(wireMessage({ content: toolUseContent, stop_reason: 'tool_use' })),
  hits_max_tokens: async () => jsonResponse(wireMessage({ stop_reason: 'max_tokens' })),
  refuses: async () => jsonResponse(wireMessage({ content: [], stop_reason: 'refusal' })),
  unknown_stop_reason: async () => jsonResponse(wireMessage({ stop_reason: 'pause_turn' })),
  context_overflow_request: async () =>
    apiError(400, 'invalid_request_error', 'prompt is too long: 250000 tokens > 200000 maximum'),
  context_overflow_generation: async () =>
    jsonResponse(wireMessage({ stop_reason: 'model_context_window_exceeded' })),
  // Never settles on its own, but honors the SDK's timeout abort — a fetch
  // that ignores the signal would hang the SDK's timeout machinery too.
  times_out: (_url, init) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () =>
        reject(new DOMException('The operation was aborted.', 'AbortError')),
      );
    }),
  server_error: async () => apiError(500, 'api_error', 'internal server error'),
  network_failure: async () => {
    throw new TypeError('fetch failed');
  },
};

function makeClient(scenario: ModelClientScenario): AnthropicModelClient {
  return new AnthropicModelClient(config, 'test-key', {
    fetch: scenarioFetch[scenario],
    maxRetries: 0,
    ...(scenario === 'times_out' ? { timeout: 50 } : {}),
  });
}

describeModelClientContract('anthropic', { makeClient });

// --- Request-shape assertions ----------------------------------------------

/** Client wired to capture the outbound request body, replying innocuously. */
function makeCapturingClient(): {
  client: AnthropicModelClient;
  body: () => Record<string, unknown>;
} {
  let captured: Record<string, unknown> | undefined;
  const client = new AnthropicModelClient(config, 'test-key', {
    maxRetries: 0,
    fetch: async (_url, init) => {
      captured = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return jsonResponse(wireMessage());
    },
  });
  return { client, body: () => captured! };
}

describe('AnthropicModelClient request shape', () => {
  it('sends model, max_tokens, the system prompt, and thinking disabled', async () => {
    const { client, body } = makeCapturingClient();
    await client.callModel(contractCustomerTurn);
    expect(body()).toMatchObject({
      model: 'claude-sonnet-5',
      max_tokens: 512,
      system: 'You are a post-purchase support agent.',
      thinking: { type: 'disabled' },
    });
  });

  it('sends tools in exact wire shape: name, description, input_schema — nothing else', async () => {
    const { client, body } = makeCapturingClient();
    await client.callModel(contractCustomerTurn);
    const tools = body()['tools'] as Record<string, unknown>[];
    expect(tools).toHaveLength(1);
    // toEqual is exact on keys: a leaked camelCase `inputSchema` (or any
    // other stray field) fails this test.
    expect(tools[0]).toEqual({
      name: 'lookup_order',
      description: 'Use to find customer order',
      input_schema: expect.objectContaining({
        type: 'object',
        properties: { orderId: expect.objectContaining({ type: 'string' }) },
        required: ['orderId'],
      }),
    });
  });

  it('maps a full tool round-trip history onto the wire faithfully', async () => {
    const history: Message[] = [
      { role: 'user', parts: [{ type: 'text', content: 'Where is order-1001?' }] },
      {
        role: 'assistant',
        parts: [
          { type: 'text', content: 'Let me look that up.' },
          {
            type: 'tool_call',
            id: 'call-1',
            name: 'lookup_order',
            args: { orderId: 'order-1001' },
          },
        ],
      },
      {
        role: 'user',
        parts: [
          {
            type: 'tool_call_response',
            id: 'call-1',
            response: '{"status":"shipped"}',
            status: 'ok',
          },
        ],
      },
    ];
    const { client, body } = makeCapturingClient();
    await client.callModel(history);
    expect(body()['messages']).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'Where is order-1001?' }] },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Let me look that up.' },
          {
            type: 'tool_use',
            id: 'call-1',
            name: 'lookup_order',
            input: { orderId: 'order-1001' },
          },
        ],
      },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'call-1',
            content: '{"status":"shipped"}',
            is_error: false,
          },
        ],
      },
    ]);
  });

  it('marks failed tool results with is_error on the wire', async () => {
    const history: Message[] = [
      {
        role: 'user',
        parts: [
          {
            type: 'tool_call_response',
            id: 'call-9',
            response: 'Order not found',
            status: 'failed',
          },
        ],
      },
    ];
    const { client, body } = makeCapturingClient();
    await client.callModel(history);
    const messages = body()['messages'] as { content: { is_error: boolean }[] }[];
    expect(messages[0]!.content[0]!.is_error).toBe(true);
  });

  it('surfaces an illegal role in history as transport_error, not a throw', async () => {
    const { client } = makeCapturingClient();
    // MessageRole makes this unrepresentable at compile time; the cast
    // simulates history deserialized from storage, where types can't vouch.
    const corrupted = [
      { role: 'system', parts: [{ type: 'text', content: 'smuggled' }] },
    ] as unknown as Message[];
    const result = await client.callModel(corrupted);
    expect(result).toMatchObject({ type: 'transport_error', errorType: '_OTHER' });
  });
});
