import { z } from 'zod';
import {
  formatMoney,
  sanitizeOrderForModel,
  type OrderBackend,
  type SanitizedOrder,
} from '../backend/index.js';
import type { ToolRegistry } from './types.js';
import { defineTool } from './utils.js';

const LookupOrderInputSchema = z.object({ orderId: z.string() });

/**
 * The order as the model reads it. Money and dates arrive pre-formatted and
 * the raw minor units / epoch values are left out on purpose: the model
 * repeats strings, it never does arithmetic on amounts or dates. The
 * sanitized order with raw values stays in `result` for the trace.
 */
type ModelOrderView = Pick<SanitizedOrder, 'id' | 'status' | 'currency' | 'shipments'> & {
  createdAt: string;
  updatedAt: string;
  items: {
    id: string;
    productName: string;
    quantity: number;
    unitPrice: string;
    lineTotal: string;
  }[];
  total: string;
};

function presentOrderForModel(order: SanitizedOrder): ModelOrderView {
  const { currency } = order;
  return {
    id: order.id,
    status: order.status,
    currency,
    createdAt: new Date(order.createdAt).toISOString(),
    updatedAt: new Date(order.updatedAt).toISOString(),
    items: order.items.map((item) => ({
      id: item.id,
      productName: item.productName,
      quantity: item.quantity,
      unitPrice: formatMoney(item.unitPriceMinorUnits, currency),
      lineTotal: formatMoney(item.unitPriceMinorUnits * item.quantity, currency),
    })),
    total: formatMoney(order.totalMinorUnits, currency),
    shipments: order.shipments,
  };
}

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
          response: JSON.stringify(presentOrderForModel(sanitizedOrder)),
        };
      },
    }),
  };
}
