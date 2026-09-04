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
  /**
   * Budget of tool rounds per turn. A round is "the model asked for tools,
   * they ran, the model was called again", so the model is called at most
   * `maxRounds + 1` times. A tool_use response past the budget is discarded
   * without running its tools and the turn fails with `max_rounds`; that
   * final model call is paid for and thrown away.
   */
  maxRounds?: number;
};

export type RunTurnResult = {
  outcome: TurnOutcome;
  updatedHistory: Message[];
};

export type SettledToolCall = ToolResult & { callId: string };
