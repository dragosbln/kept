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

/**
 * A registry entry with its schema type erased. `any` rather than `z.ZodType`
 * on purpose: with the concrete schema gone, `execute` would have to accept
 * `unknown`, and no real tool does. The executor restores the link at run
 * time by parsing the input with the entry's own schema before calling it.
 */
export type AnyToolDefinition = ToolDefinition<any>;

export type ToolRegistry = { [key in ToolName]: AnyToolDefinition };
