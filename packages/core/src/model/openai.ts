// OpenAI implementation of ModelClient, on the Chat Completions API rather
// than the newer Responses API — deliberately: Ollama (and most local
// runtimes) expose an OpenAI-compatible Chat Completions endpoint, so this
// one client covers both "openai" and "local model" through `baseURL`.
//
// Wire-format differences from Anthropic, so the mappings read sanely:
// - The system prompt is a message (first in the array), not a parameter.
// - Tool results are per-call `role: "tool"` messages that must directly
//   follow the assistant message carrying the calls — one internal user
//   message with N results fans out into N wire messages.
// - Tool arguments travel as a JSON *string*, not an object, and can be
//   malformed; see parseToolArgs.
// - There is no response-flavored context overflow: the window can only be
//   exceeded by the request, surfacing as a 400 with a structured
//   `code: "context_length_exceeded"` (no message-regex needed).

import OpenAI, { APIConnectionTimeoutError, APIError, BadRequestError } from 'openai';
import type { ClientOptions } from 'openai';
import type { ChatCompletion, ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import type { ErrorType, Message, MessagePart, ToolArgs } from '../messages.js';
import type { ModelClient } from './client.js';
import type {
  CallModelResponse,
  CallModelResponseType,
  ModelClientConfig,
  ModelResponded,
} from './types.js';

/** Same shape and purpose as AnthropicTransportOptions — see anthropic.ts. */
export type OpenAITransportOptions = Pick<
  ClientOptions,
  'fetch' | 'baseURL' | 'timeout' | 'maxRetries'
>;

/**
 * Tool args arrive as a model-written JSON string; the model can emit
 * garbage. A parse failure is contained here as empty args — the executor's
 * schema validation then settles the call as a failed tool_result, which is
 * the deterministic path for "model sent invalid input". Never throw.
 */
function parseToolArgs(raw: string): ToolArgs {
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null ? (parsed as ToolArgs) : {};
  } catch {
    return {};
  }
}

export class OpenAIModelClient implements ModelClient {
  private config: ModelClientConfig;
  private client: OpenAI;

  constructor(config: ModelClientConfig, apiKey: string, transport?: OpenAITransportOptions) {
    this.config = config;
    this.client = new OpenAI({ apiKey, ...transport });
  }

  private toOpenAIMessages(messages: Message[]): ChatCompletionMessageParam[] {
    const wire: ChatCompletionMessageParam[] = [
      { role: 'system', content: this.config.promptData.text },
    ];

    for (const msg of messages) {
      if (msg.role === 'user') {
        // Tool results first: the wire demands they directly follow the
        // assistant message that requested them.
        for (const part of msg.parts) {
          if (part.type === 'tool_call') {
            throw new Error('tool_call part in a user message: loop bug');
          }
          if (part.type === 'tool_call_response') {
            wire.push({ role: 'tool', tool_call_id: part.id, content: part.response });
          }
        }
        const texts = msg.parts.filter((part) => part.type === 'text');
        if (texts.length > 0) {
          wire.push({ role: 'user', content: texts.map((part) => part.content).join('\n\n') });
        }
      } else if (msg.role === 'assistant') {
        const texts = msg.parts.filter((part) => part.type === 'text');
        const toolCalls = msg.parts.filter((part) => part.type === 'tool_call');
        if (msg.parts.some((part) => part.type === 'tool_call_response')) {
          throw new Error('tool_call_response part in an assistant message: loop bug');
        }
        wire.push({
          role: 'assistant',
          content: texts.length > 0 ? texts.map((part) => part.content).join('\n\n') : null,
          ...(toolCalls.length > 0
            ? {
                tool_calls: toolCalls.map((part) => ({
                  id: part.id,
                  type: 'function' as const,
                  function: { name: part.name, arguments: JSON.stringify(part.args) },
                })),
              }
            : {}),
        });
      } else {
        throw new Error(`Invalid role in messages array: ${msg.role}`);
      }
    }

    return wire;
  }

  private fromOpenAIChoice(choice: ChatCompletion.Choice): MessagePart[] {
    const parts: MessagePart[] = [];
    const { content, refusal, tool_calls: toolCalls } = choice.message;
    // A refusal's explanation is trace-worthy even though history drops it.
    const text = content ?? refusal;
    if (text) {
      parts.push({ type: 'text', content: text });
    }
    for (const toolCall of toolCalls ?? []) {
      if (toolCall.type !== 'function') continue; // custom-tool calls can't occur: we register none
      parts.push({
        type: 'tool_call',
        id: toolCall.id,
        name: toolCall.function.name,
        args: parseToolArgs(toolCall.function.arguments),
      });
    }
    return parts;
  }

  /**
   * Unlike Anthropic, overflow never appears here — the return type says so.
   * `refusal` is a field on the message rather than a finish reason, hence
   * the extra parameter.
   */
  private fromFinishReason(
    finishReason: ChatCompletion.Choice['finish_reason'] | null,
    refusal: string | null,
  ): Exclude<CallModelResponseType, 'transport_error' | 'context_window_exceeded'> {
    if (refusal) return 'refusal';
    switch (finishReason) {
      case 'stop':
        return 'end_turn';
      case 'tool_calls':
        return 'tool_use';
      case 'length':
        return 'max_tokens';
      case 'content_filter':
        return 'refusal';
      default:
        return 'unknown';
    }
  }

  async callModel(messages: Message[]): Promise<CallModelResponse> {
    try {
      const completion = await this.client.chat.completions.create({
        model: this.config.model,
        max_completion_tokens: this.config.maxTokens,
        messages: this.toOpenAIMessages(messages),
        tools: this.config.toolRegistry.map((tool) => ({
          type: 'function' as const,
          function: {
            name: tool.name,
            description: tool.description,
            parameters: tool.inputSchema,
          },
        })),
      });

      const usage = {
        inputTokens: completion.usage?.prompt_tokens ?? 0,
        outputTokens: completion.usage?.completion_tokens ?? 0,
      };

      const choice = completion.choices[0];
      if (!choice) {
        // Malformed but not throw-worthy: classify, record, move on.
        return {
          type: 'unknown',
          stopReason: 'no_choices',
          message: { role: 'assistant', parts: [] },
          usage,
        };
      }

      const modelResponded: ModelResponded = {
        message: { role: 'assistant', parts: this.fromOpenAIChoice(choice) },
        usage,
      };
      if (choice.finish_reason) {
        modelResponded.message.finishReason = choice.finish_reason;
      }

      const responseType = this.fromFinishReason(
        choice.finish_reason,
        choice.message.refusal ?? null,
      );

      if (responseType === 'unknown') {
        return { type: responseType, ...modelResponded, stopReason: choice.finish_reason || '' };
      }

      return { type: responseType, ...modelResponded };
    } catch (error) {
      if (error instanceof BadRequestError && error.code === 'context_length_exceeded') {
        return { type: 'context_window_exceeded' };
      }

      let errorType: ErrorType;
      if (error instanceof APIConnectionTimeoutError) {
        errorType = 'timeout';
      } else if (error instanceof APIError) {
        errorType = error.status ? String(error.status) : '_OTHER';
      } else {
        errorType = '_OTHER';
      }

      return {
        type: 'transport_error',
        errorType,
        error: error instanceof Error ? error : new Error(String(error)),
      };
    }
  }

  getConfig(): Readonly<ModelClientConfig> {
    // Deep copy: the config is this client's contract with its callers, and
    // handing out the live object would let them mutate it under us.
    return structuredClone(this.config);
  }
}
