// schemas, createToolRegistry
import { z } from 'zod';
import { sanitizeOrderForModel, type OrderBackend } from '../backend/index.js';
import type { ToolRegistry } from './types.js';
import { defineTool } from './utils.js';

const LookupOrderInputSchema = z.object({ orderId: z.string() });

export function createToolRegistry(backend: OrderBackend): ToolRegistry {
  return {
    lookup_order: defineTool({
      description: 'Use to find customer order',
      inputSchema: LookupOrderInputSchema,
      execute: async (input) => {
        const order = await backend.findOrder(input.orderId);

        if (!order) {
          return {
            resultState: 'failed',
            result: null,
            response: 'Order not found',
          };
        }

        const sanitizedOrder = sanitizeOrderForModel(order);

        return {
          resultState: 'ok',
          result: sanitizedOrder,
          response: JSON.stringify(sanitizedOrder),
        };
      },
    }),
  };
}
