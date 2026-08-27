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
};

export type ToolDefinition<TSchema extends z.ZodType> = {
  description: string;
  inputSchema: TSchema;
  execute: (input: z.infer<TSchema>, ctx: ToolExecuteContext) => Promise<ToolResult>;
};

export type ToolRegistry = { [key in ToolName]: ToolDefinition<any> };
