import type { Order, SanitizedOrder } from './types.js';

export function sanitizeOrderForModel(order: Order): SanitizedOrder {
  return {
    id: order.id,
    createdAt: order.createdAt,
    updatedAt: order.updatedAt,
    status: order.status,
    items: order.items,
    totalMinorUnits: order.totalMinorUnits,
    currency: order.currency,
    shipments: order.shipments,
  };
}
