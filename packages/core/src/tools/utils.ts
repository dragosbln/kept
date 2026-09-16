import { z } from 'zod';
import type { ToolDefinition, ToolResult } from './types.js';
import type { Currency, IssueRefundResponse, SanitizedOrder } from '../backend/types.js';
import type { RefundLedgerRecord } from '../refund-ledger/types.js';
import { formatMoney } from '../backend/utils.js';

/**
 * Constructors for the three result states, so a tool reads as a list of
 * settlements rather than object literals. `response` is the model-facing
 * text, `result` the trace-facing record (null when there is nothing to
 * record). `unknown` appends the do-not-retry instruction itself: a result
 * whose side effects are unknown must never invite a second attempt, and
 * this is the one place that sentence is written.
 */
export const settle = {
  ok: (response: string, result: unknown = null): ToolResult => ({
    resultState: 'ok',
    result,
    response,
  }),
  failed: (response: string, result: unknown = null): ToolResult => ({
    resultState: 'failed',
    result,
    response,
  }),
  unknown: (response: string, result: unknown = null): ToolResult => ({
    resultState: 'unknown',
    result,
    response: `${response} Do not retry.`,
  }),
};

export function defineTool<TSchema extends z.ZodType>(
  def: ToolDefinition<TSchema>,
): ToolDefinition<TSchema> {
  return def;
}

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

export function presentOrderForModel(order: SanitizedOrder): ModelOrderView {
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

/**
 * A refund that went through, as the model reads it. An allowlist, like the
 * order view: what the customer can be told (the backend's refund reference,
 * what was refunded, the amount that actually moved, pre-formatted) and
 * nothing else. Left out on purpose: the customer key (pseudonymous, and no
 * use to the model), the conversation id, prompt hash and call id (trace
 * plumbing), the ledger's own record id, and any view of prior refunds. The
 * ledger record with all of it stays in `result` for the trace.
 */
type ModelRefundView = Pick<
  RefundLedgerRecord,
  'status' | 'orderId' | 'orderItemId' | 'quantity'
> & {
  refundId: string;
  amount: string;
  currency: Currency;
};

/**
 * Takes the ok backend response beside the record so the view reports what
 * the backend actually moved, not the expected amount recorded before the
 * call, and so the refund reference is present by type rather than by
 * assertion. Only the ok branch can call it, which is the point.
 */
export function presentRefundForModel(
  record: RefundLedgerRecord,
  moved: Extract<IssueRefundResponse, { status: 'ok' }>,
): ModelRefundView {
  return {
    status: record.status,
    orderId: record.orderId,
    orderItemId: record.orderItemId,
    quantity: record.quantity,
    currency: moved.currency,
    refundId: moved.refundId,
    amount: formatMoney(moved.amountMinorUnits, moved.currency),
  };
}
