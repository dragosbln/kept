import Anthropic, { APIConnectionTimeoutError, APIError, BadRequestError } from '@anthropic-ai/sdk';
import type { ClientOptions } from '@anthropic-ai/sdk';
import type { ErrorType, Message, MessagePart, ToolArgs } from '../messages.js';
import type { ModelClient } from './client.js';
import type {
  CallModelResponse,
  CallModelResponseType,
  ModelClientConfig,
  ModelResponded,
} from './types.js';
import type {
  ContentBlock,
  StopReason,
  MessageParam,
  ContentBlockParam,
} from '@anthropic-ai/sdk/resources';

/**
 * Transport knobs forwarded to the SDK constructor. Exists so tests can fake
 * the wire (custom fetch, zero retries, short timeout) and so an alternate
 * endpoint can be pointed at without touching the client's logic.
 */
export type AnthropicTransportOptions = Pick<
  ClientOptions,
  'fetch' | 'baseURL' | 'timeout' | 'maxRetries'
>;

export class AnthropicModelClient implements ModelClient {
  private config: ModelClientConfig;
  private client: Anthropic;

  constructor(config: ModelClientConfig, apiKey: string, transport?: AnthropicTransportOptions) {
    this.config = config;
    this.client = new Anthropic({ apiKey, ...transport });
  }

  private toAnthropicMessages(messages: Message[]): MessageParam[] {
    return messages.map((msg): MessageParam => {
      if (msg.role !== 'user' && msg.role !== 'assistant') {
        throw new Error(`Invalid role in messages array: ${msg.role}`);
      }
      return {
        role: msg.role === 'assistant' ? 'assistant' : 'user',
        content: msg.parts.map((part): ContentBlockParam => {
          switch (part.type) {
            case 'text':
              return { type: 'text', text: part.content };
            case 'tool_call':
              return { type: 'tool_use', id: part.id, name: part.name, input: part.args };
            case 'tool_call_response':
              return {
                type: 'tool_result',
                tool_use_id: part.id,
                content: part.response,
                is_error: part.status === 'failed',
              };
          }
        }),
      };
    });
  }

  private fromAnthropicContent(blocks: ContentBlock[]): MessagePart[] {
    return blocks.flatMap((block): MessagePart[] => {
      switch (block.type) {
        case 'text':
          return [{ type: 'text', content: block.text }];
        case 'tool_use':
          return [
            { type: 'tool_call', id: block.id, name: block.name, args: block.input as ToolArgs },
          ];
        default:
          /**
           * thinking disabled, no server tools
           */
          return [];
      }
    });
  }

  private fromStopReason(
    stopReason: StopReason | null,
  ): Exclude<CallModelResponseType, 'transport_error'> {
    switch (stopReason) {
      case 'max_tokens':
        return 'max_tokens';
      case 'end_turn':
        return 'end_turn';
      case 'tool_use':
        return 'tool_use';
      case 'refusal':
        return 'refusal';
      case 'model_context_window_exceeded':
        return 'context_window_exceeded';
      case 'stop_sequence':
      case 'pause_turn':
      default:
        return 'unknown';
    }
  }

  async callModel(messages: Message[]): Promise<CallModelResponse> {
    try {
      const response = await this.client.messages.create({
        max_tokens: this.config.maxTokens,
        model: this.config.model,
        messages: this.toAnthropicMessages(messages),
        system: this.config.promptData.text,
        thinking: { type: 'disabled' },
        tools: this.config.toolRegistry.map((tool) => ({
          name: tool.name,
          description: tool.description,
          input_schema: tool.inputSchema as Anthropic.Tool.InputSchema,
        })),
      });

      const responseType = this.fromStopReason(response.stop_reason);

      const modelResponded: ModelResponded = {
        message: {
          role: 'assistant',
          parts: this.fromAnthropicContent(response.content),
        },
        usage: {
          inputTokens: response.usage.input_tokens,
          outputTokens: response.usage.output_tokens,
        },
      };

      if (responseType === 'context_window_exceeded') {
        return {
          type: 'context_window_exceeded',
          ...modelResponded,
        };
      }

      if (response.stop_reason) {
        modelResponded.message.finishReason = response.stop_reason;
      }

      if (responseType === 'unknown') {
        return {
          type: responseType,
          ...modelResponded,
          stopReason: response.stop_reason || '',
        };
      }

      return {
        type: responseType,
        ...modelResponded,
      };
    } catch (error) {
      if (error instanceof BadRequestError && error.message.match(/prompt is too long/)) {
        return {
          type: 'context_window_exceeded',
        };
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
    return structuredClone(this.config);
  }
}
