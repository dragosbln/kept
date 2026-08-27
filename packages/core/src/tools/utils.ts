import { z } from 'zod';
import type { ToolDefinition } from './types.js';

export function defineTool<TSchema extends z.ZodType>(
  def: ToolDefinition<TSchema>,
): ToolDefinition<TSchema> {
  return def;
}
