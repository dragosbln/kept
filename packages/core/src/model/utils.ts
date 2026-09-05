import { z } from 'zod';
import type { ToolName, ToolRegistry } from '../tools/types.js';
import type { ModelToolDefinition } from './types.js';

export function toModelToolRegistry(registry: ToolRegistry): ModelToolDefinition[] {
  return (Object.keys(registry) as ToolName[]).map((key) => ({
    name: key,
    description: registry[key].description,
    inputSchema: z.toJSONSchema(registry[key].inputSchema),
  }));
}
