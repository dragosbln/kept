import type { ErrorType, Message } from '../messages.js';
import type { PromptData } from '../prompt/index.js';
import type { ToolName } from '../tools/types.js';

export type ModelToolDefinition = {
  name: ToolName;
  description: string;
  inputSchema: Record<string, unknown>;
};

export type ModelProviders = 'anthropic' | 'openai';

export type ModelClientConfig = {
  provider: ModelProviders;
  model: string;
  maxTokens: number;
  promptData: PromptData;
  toolRegistry: ModelToolDefinition[];
};

export type ModelResponded = {
  message: Message;
  usage: { inputTokens: number; outputTokens: number };
};

export type CallModelResponse =
  | {
      type: 'transport_error';
      errorType: ErrorType;
      error: Error;
    }
  | ({
      type: 'tool_use';
    } & ModelResponded)
  | ({
      type: 'end_turn';
    } & ModelResponded)
  | ({
      type: 'refusal';
    } & ModelResponded)
  | ({
      type: 'max_tokens';
    } & ModelResponded)
  | ({
      type: 'context_window_exceeded';
    } & Partial<ModelResponded>)
  | ({
      type: 'unknown';
      stopReason: string;
    } & ModelResponded);

export type CallModelResponseType = CallModelResponse['type'];
