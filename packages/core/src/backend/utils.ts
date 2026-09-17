import type { Currency, Order, SanitizedOrder } from './types.js';

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

const moneyFormatters = new Map<Currency, Intl.NumberFormat>();

/**
 * Minor units → a display string ("$20.50", "€159.00"), locale fixed so the
 * output is deterministic. Exists so amounts reach the model pre-formatted:
 * arithmetic on money is never the model's job.
 */
export function formatMoney(minorUnits: number, currency: Currency): string {
  let formatter = moneyFormatters.get(currency);
  if (!formatter) {
    formatter = new Intl.NumberFormat('en-US', { style: 'currency', currency });
    moneyFormatters.set(currency, formatter);
  }
  const divisor = 10 ** (formatter.resolvedOptions().maximumFractionDigits ?? 2);
  return formatter.format(minorUnits / divisor);
}

type RefundAmountResponse = {
  amountMinorUnits: number;
  currency: Currency;
};

/**
 * What refunding `quantity` units of one line is worth: unit price ×
 * quantity in the order's currency, from canonical fields only. Exists so
 * the ledger can record the expected amount before the backend answers, and
 * so the model never names an amount. Throws only on a caller bug (a line
 * the order does not have): the tool reads the line first, and a throw
 * before any write settles as a plain `failed` in the executor.
 */
export function refundAmountFor(
  order: Order,
  orderItemId: string,
  quantity: number,
): RefundAmountResponse {
  const orderItem = order.items.find((item) => item.id === orderItemId);
  if (!orderItem) {
    throw new Error(`Order ${order.id} has no line ${orderItemId}`);
  }

  return {
    amountMinorUnits: orderItem.unitPriceMinorUnits * quantity,
    currency: order.currency,
  };
}
