// Canonical demo dataset. Double duty: seed for the DemoBackend and the
// OrderBackend contract fixture — a backend under contract must serve these
// orders, so adapters (week 3: Medusa) seed their store from this file.
//
// Totals are computed from the lines, never hand-written; v0 models no
// shipping or tax, so total = Σ unit × qty holds by construction.
//
// `now` keeps the dataset deterministic under test (fixed default) while the
// demo app may pass Date.now() at boot so order ages read naturally.

import type { Order, OrderItem } from './types.js';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** Fixed "now" for deterministic fixtures: 2026-08-20T00:00:00Z. */
export const DEMO_SEED_EPOCH = 1_787_184_000_000;

function computeTotal(items: OrderItem[]): number {
  return items.reduce((sum, item) => sum + item.unitPriceMinorUnits * item.quantity, 0);
}

function order(spec: Omit<Order, 'totalMinorUnits'>): Order {
  return { ...spec, totalMinorUnits: computeTotal(spec.items) };
}

export function makeDemoOrders(now: number = DEMO_SEED_EPOCH): Order[] {
  return [
    // Plain WISMO case: everything in one shipment, on its way.
    order({
      id: 'order-1001',
      createdAt: now - 3 * DAY,
      updatedAt: now - 1 * DAY,
      email: 'dana@example.com',
      status: 'shipped',
      currency: 'USD',
      items: [
        {
          id: 'order-1001-line-1',
          productId: 'sneaker-blaze',
          productName: 'Blaze Runner Sneakers',
          quantity: 1,
          unitPriceMinorUnits: 2050,
        },
        {
          id: 'order-1001-line-2',
          productId: 'sock-wool',
          productName: 'Wool Socks (3-pack)',
          quantity: 2,
          unitPriceMinorUnits: 4559,
        },
      ],
      shipments: [
        {
          id: 'order-1001-shipment-1',
          carrier: 'UPS',
          status: 'in_transit',
          carrierStatus: 'Departed regional facility',
          trackingNumber: '1Z999AA10123456784',
          items: [
            { orderItemId: 'order-1001-line-1', quantity: 1 },
            { orderItemId: 'order-1001-line-2', quantity: 2 },
          ],
        },
      ],
    }),

    // Split shipment with a quantity split: a qty-2 line delivered 1-and-1
    // across two shipments. The week-2 WISMO/split-refund fixture.
    order({
      id: 'order-1002',
      createdAt: now - 6 * DAY,
      updatedAt: now - 2 * HOUR,
      email: 'sam@example.com',
      status: 'partially_delivered',
      currency: 'USD',
      items: [
        {
          id: 'order-1002-line-1',
          productId: 'boot-trail',
          productName: 'Trail Boots',
          quantity: 2,
          unitPriceMinorUnits: 8900,
        },
        {
          id: 'order-1002-line-2',
          productId: 'insole-comfort',
          productName: 'Comfort Insoles',
          quantity: 1,
          unitPriceMinorUnits: 1200,
        },
      ],
      shipments: [
        {
          id: 'order-1002-shipment-1',
          carrier: 'DHL',
          status: 'delivered',
          carrierStatus: 'Delivered — signed by resident',
          trackingNumber: 'JD014600003RO',
          items: [
            { orderItemId: 'order-1002-line-1', quantity: 1 },
            { orderItemId: 'order-1002-line-2', quantity: 1 },
          ],
        },
        {
          id: 'order-1002-shipment-2',
          carrier: 'DHL',
          status: 'in_transit',
          carrierStatus: 'Processed at origin hub',
          trackingNumber: 'JD014600004RO',
          items: [{ orderItemId: 'order-1002-line-1', quantity: 1 }],
        },
      ],
    }),

    // Fresh order, nothing shipped yet: the "where is it" answer is a date,
    // not a tracking number.
    order({
      id: 'order-1003',
      createdAt: now - 6 * HOUR,
      updatedAt: now - 6 * HOUR,
      email: 'kai@example.com',
      status: 'pending',
      currency: 'USD',
      items: [
        {
          id: 'order-1003-line-1',
          productId: 'sneaker-blaze',
          productName: 'Blaze Runner Sneakers',
          quantity: 1,
          unitPriceMinorUnits: 2050,
        },
      ],
      shipments: [],
    }),

    // Delivered a while ago, non-USD: the week-2 return/refund candidate and
    // the currency-variety fixture.
    order({
      id: 'order-1004',
      createdAt: now - 12 * DAY,
      updatedAt: now - 9 * DAY,
      email: 'ana@example.com',
      status: 'delivered',
      currency: 'EUR',
      items: [
        {
          id: 'order-1004-line-1',
          productId: 'jacket-rain',
          productName: 'Rain Shell Jacket',
          quantity: 1,
          unitPriceMinorUnits: 15900,
        },
      ],
      shipments: [
        {
          id: 'order-1004-shipment-1',
          carrier: 'GLS',
          status: 'delivered',
          carrierStatus: 'Delivered',
          trackingNumber: 'GLS0012345678',
          items: [{ orderItemId: 'order-1004-line-1', quantity: 1 }],
        },
      ],
    }),
  ];
}
