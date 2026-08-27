import type { OrderBackend } from './order-backend.js';
import type { Order } from './types.js';

export class DemoBackend implements OrderBackend {
  private orders: Order[];

  constructor(orders: Order[]) {
    this.orders = orders;
  }

  async findOrder(orderId: string): Promise<Order | null> {
    return this.orders.find((order) => order.id === orderId) ?? null;
  }
}
