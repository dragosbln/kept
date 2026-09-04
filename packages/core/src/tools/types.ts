import { z } from 'zod';
import type { ToolResultState } from '../messages.js';

export type ToolName = 'lookup_order';

export type ToolResult = {
  resultState: ToolResultState;
  result: unknown;
  response: string;
};

export type ToolExecuteContext = {
  callId: string;
  /**
   * Fires when the executor gives up on the call (timeout). A tool that can
   * stop in-flight work should honour it; the executor settles the call as
   * `unknown` either way, because whether the work happened is exactly what
   * it no longer knows.
   */
  signal: AbortSignal;
};

export type ToolDefinition<TSchema extends z.ZodType> = {
  description: string;
  inputSchema: TSchema;
  execute: (input: z.infer<TSchema>, ctx: ToolExecuteContext) => Promise<ToolResult>;
};

export type ToolRegistry = { [key in ToolName]: ToolDefinition<any> };
