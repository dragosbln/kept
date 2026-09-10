import type { IssueRefundParams, IssueRefundResponse, Order } from './types.js';

export interface OrderBackend {
  findOrder(orderId: string): Promise<Order | null>;
  issueRefund(params: IssueRefundParams): Promise<IssueRefundResponse>;
}
