import type { OrderBackend } from './order-backend.js';
import type { IssueRefundParams, IssueRefundResponse, Order } from './types.js';

type RefundedItems = {
  [orderId: string]: {
    [orderItemId: string]: number;
  };
};

/**
 * What the demo remembers per idempotency key: the request it was given and
 * the outcome it produced, written together. `type` is there so a future
 * write of another kind under the same key is a conflict, not a replay.
 */
type RememberedRequest = {
  type: 'issue_refund';
  createdAt: number;
  input: IssueRefundParams;
  output: IssueRefundResponse;
};

function sameRequest(a: IssueRefundParams, b: IssueRefundParams): boolean {
  return a.orderId === b.orderId && a.orderItemId === b.orderItemId && a.quantity === b.quantity;
}

export class DemoBackend implements OrderBackend {
  private orders: Order[];
  private refundedItems: RefundedItems;
  private requests = new Map<string, RememberedRequest>();

  constructor(orders: Order[], refundedItems?: RefundedItems) {
    this.orders = orders;
    this.refundedItems = refundedItems || {};
  }

  async findOrder(orderId: string): Promise<Order | null> {
    return this.orders.find((order) => order.id === orderId) ?? null;
  }

  /**
   * See OrderBackend.issueRefund for the contract. Request and outcome are
   * remembered in one write after the execution, and the method has no
   * await, so a request without an outcome cannot be observed: that is the
   * atomicity the port asks of every backend, free here. A key that is
   * already known is either a conflict or a replay; it never executes.
   */
  async issueRefund(key: string, params: IssueRefundParams): Promise<IssueRefundResponse> {
    const seen = this.requests.get(key);
    if (seen) {
      return sameRequest(seen.input, params)
        ? seen.output
        : { status: 'failed', errorType: 'key_conflict' };
    }
    const output = this.refund(params);
    this.requests.set(key, {
      type: 'issue_refund',
      createdAt: Date.now(),
      input: { ...params },
      output,
    });
    return output;
  }

  private refund(params: IssueRefundParams): IssueRefundResponse {
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
