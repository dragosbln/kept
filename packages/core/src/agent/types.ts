import type { z } from 'zod';
import type { ToolDefinition, ToolRegistry, ToolResult } from '../tools/types.js';
import type { ModelClient } from '../model/client.js';
import type { Trace } from '../tracing/trace.js';
import type { Message } from '../messages.js';
import type { TurnOutcome } from '../tracing/types.js';

export type ExecuteToolParams<TSchema extends z.ZodType> = {
  tool: ToolDefinition<TSchema>;
  input: unknown;
  callId: string;
  timeoutMs?: number | undefined;
};

export type ExecuteToolCallArgs = {
  callId: string;
  name: string;
  args: Record<string, unknown>;
};

/**
 * The budgets one turn runs under. Anything omitted from
 * RunTurnParams.limits takes its DEFAULT_TURN_LIMITS value.
 */
export type TurnLimits = {
  /**
   * Budget of tool rounds per turn. A round is "the model asked for tools,
   * they ran, the model was called again", so the model is called at most
   * `maxRounds + 1` times. A tool_use response past the budget is discarded
   * without running its tools and the turn fails with `max_rounds`; that
   * final model call is paid for and thrown away.
   */
  maxRounds: number;
  /**
   * Wall-clock budget per tool call. A call that outlives it settles as
   * `unknown`, because whether the work happened is exactly what the
   * executor no longer knows; the tool sees the abort signal so it can stop.
   */
  toolTimeoutMs: number;
};

/**
 * Where runTurn reports the internal errors it turns into failed(internal).
 * Console-shaped on purpose; defaults to console.
 */
export type TurnLogger = {
  error: (message: string, error: unknown) => void;
};

export type RunTurnParams = {
  /** The conversation so far, provider-valid. runTurn never mutates it. */
  history: Message[];
  /** The customer message this turn answers. */
  message: string;
  modelClient: ModelClient;
  tools: ToolRegistry;
  trace: Trace;
  limits?: Partial<TurnLimits>;
  logger?: TurnLogger;
};

export type RunTurnResult = {
  outcome: TurnOutcome;
  /**
   * What to persist: the turn's messages appended to the input history on a
   * reply, the input history untouched on every other outcome.
   */
  updatedHistory: Message[];
};

export type SettledToolCall = ToolResult & { callId: string };
