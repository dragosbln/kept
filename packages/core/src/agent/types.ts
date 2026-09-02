import type { z } from 'zod';
import type {
  ToolDefinition,
  ToolExecuteContext,
  ToolRegistry,
  ToolResult,
} from '../tools/types.js';
import type { Conversation } from '../conversation/types.js';
import type { ModelClient } from '../model/client.js';
import type { Trace } from '../tracing/trace.js';
import type { Message } from '../messages.js';
import type { CallModelResponseType } from '../model/types.js';
import type { TurnOutcome } from '../tracing/types.js';

export type ExecuteToolParams<TSchema extends z.ZodType> = {
  tool: ToolDefinition<TSchema>;
  input: unknown;
  ctx: ToolExecuteContext;
  timeoutMs?: number | undefined;
};

export type ExecuteToolCallArgs = {
  callId: string;
  name: string;
  args: Record<string, unknown>;
};

export type RunTurnParams = {
  conversation: Conversation;
  message: string;
  modelClient: ModelClient;
  tools: ToolRegistry;
  trace: Trace;
  maxRounds?: number;
};

export type RunTurnResult = {
  outcome: TurnOutcome;
  updatedHistory: Message[];
};

export type RecursiveRunTurnParams = {
  messages: Message[];
  modelClient: ModelClient;
  tools: ToolRegistry;
  trace: Trace;
  turnSpanId: string;
  round: number;
  maxRounds?: number | undefined;
};

export type LoopResultType = Exclude<CallModelResponseType, 'tool_use'> | 'max_turns';

export type RecursiveRunReturnType = {
  type: LoopResultType;
  messages: Message[];
};

export type SettledToolCall = ToolResult & { callId: string };
