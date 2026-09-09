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
