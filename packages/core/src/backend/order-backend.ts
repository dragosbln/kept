import type { Order } from './types.js';

export interface OrderBackend {
  findOrder(orderId: string): Promise<Order | null>;
}
