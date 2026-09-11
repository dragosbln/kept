import type { OrderBackend } from './order-backend.js';
import type { IssueRefundParams, IssueRefundResponse, Order } from './types.js';

type RefundedItems = {
  [orderId: string]: {
    [orderItemId: string]: number;
  };
};

export class DemoBackend implements OrderBackend {
  private orders: Order[];
  private refundedItems: RefundedItems;

  constructor(orders: Order[], refundedItems?: RefundedItems) {
    this.orders = orders;
    this.refundedItems = refundedItems || {};
  }

  async findOrder(orderId: string): Promise<Order | null> {
    return this.orders.find((order) => order.id === orderId) ?? null;
  }

  /**
   * See OrderBackend.issueRefund for the contract. The demo ignores `key`
   * today; replay protection arrives with the idempotency work.
   */
  async issueRefund(params: IssueRefundParams): Promise<IssueRefundResponse> {
    if (params.quantity <= 0 || !Number.isInteger(params.quantity)) {
      return {
        status: 'failed',
        errorType: 'quantity_invalid',
      };
    }
    const order = this.orders.find((ord) => ord.id === params.orderId);
    if (!order) {
      return {
        status: 'failed',
        errorType: 'order_not_found',
      };
    }
    // No delivery check here on purpose: delivery is policy, see the port.
    const orderItem = order.items.find((it) => it.id === params.orderItemId);
    if (!orderItem) {
      return {
        status: 'failed',
        errorType: 'line_not_found',
      };
    }
    const refundedOrderItemQuantity = this.refundedItems[params.orderId]?.[params.orderItemId] || 0;
    if (params.quantity > orderItem.quantity - refundedOrderItemQuantity) {
      return {
        status: 'failed',
        errorType: 'quantity_exceeds_unrefunded',
      };
    }

    // in place, fine for demo
    this.refundedItems[params.orderId] = {
      ...this.refundedItems[params.orderId],
      [params.orderItemId]: params.quantity + (refundedOrderItemQuantity || 0),
    };

    const refundTotal = orderItem.unitPriceMinorUnits * params.quantity;

    return {
      status: 'ok',
      refundId: crypto.randomUUID(),
      amountMinorUnits: refundTotal,
      currency: order.currency,
    };
  }
}
