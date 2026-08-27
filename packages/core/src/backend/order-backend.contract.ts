// The OrderBackend contract: one suite, every implementation. A backend
// under contract must serve the canonical demo dataset (seed-orders.ts) —
// the demo backend is seeded with it directly; adapters seed their store
// from it. This suite is what makes the interface real: every method and
// every canonical-model invariant the tools rely on gets pinned here, and
// "both backends pass the same tool tests" is enforced, not intended.
//
// Equivalence is asserted at identity/structure level, not deep equality:
// a real store may stamp its own timestamps. Tighten deliberately, not by
// accident, when the Medusa adapter lands.

import { describe, it, expect } from 'vitest';
import type { OrderBackend } from './order-backend.js';
import type { Order } from './types.js';
import { makeDemoOrders } from './seed-orders.js';

/** Every demo order fetched through the backend, paired with its fixture. */
async function findAllDemoOrders(
  backend: OrderBackend,
): Promise<{ expected: Order; found: Order | null }[]> {
  const expectedOrders = makeDemoOrders();
  const foundOrders = await Promise.all(expectedOrders.map((order) => backend.findOrder(order.id)));
  return expectedOrders.map((expected, index) => ({ expected, found: foundOrders[index]! }));
}

export function describeOrderBackendContract(
  name: string,
  makeBackend: () => Promise<OrderBackend>,
): void {
  describe(`OrderBackend contract: ${name}`, () => {
    it('returns null for an unknown order id', async () => {
      const backend = await makeBackend();
      expect(await backend.findOrder('nope')).toBeNull();
    });

    it('returns null, not a throw, for degenerate ids', async () => {
      const backend = await makeBackend();
      expect(await backend.findOrder('')).toBeNull();
      expect(await backend.findOrder('order-1001 OR 1=1')).toBeNull();
    });

    it('serves every canonical demo order by id', async () => {
      const backend = await makeBackend();
      for (const { expected, found } of await findAllDemoOrders(backend)) {
        expect(found, `order ${expected.id} missing`).not.toBeNull();
        expect(found).toMatchObject({
          id: expected.id,
          email: expected.email,
          status: expected.status,
          currency: expected.currency,
        });
        expect(found!.items).toHaveLength(expected.items.length);
        expect(found!.shipments).toHaveLength(expected.shipments.length);
      }
    });

    it('honors the money invariant: total = Σ unit price × quantity', async () => {
      const backend = await makeBackend();
      for (const { expected, found } of await findAllDemoOrders(backend)) {
        const computed = found!.items.reduce(
          (sum, item) => sum + item.unitPriceMinorUnits * item.quantity,
          0,
        );
        expect(found!.totalMinorUnits, `order ${expected.id}`).toBe(computed);
      }
    });

    it('preserves the multi-shipment quantity split', async () => {
      const backend = await makeBackend();
      const split = (await backend.findOrder('order-1002'))!;
      expect(split.shipments).toHaveLength(2);
      const line1Quantities = split.shipments
        .flatMap((shipment) => shipment.items)
        .filter((item) => item.orderItemId === 'order-1002-line-1')
        .map((item) => item.quantity);
      expect(line1Quantities).toEqual([1, 1]);
    });

    it('never ships more of a line than the order contains', async () => {
      const backend = await makeBackend();
      for (const { expected, found } of await findAllDemoOrders(backend)) {
        for (const line of found!.items) {
          const shipped = found!.shipments
            .flatMap((shipment) => shipment.items)
            .filter((item) => item.orderItemId === line.id)
            .reduce((sum, item) => sum + item.quantity, 0);
          expect(shipped, `order ${expected.id}, line ${line.id}`).toBeLessThanOrEqual(
            line.quantity,
          );
        }
      }
    });

    it('reads are stable - repeated finds agree', async () => {
      const backend = await makeBackend();
      const first = await backend.findOrder('order-1001');
      const second = await backend.findOrder('order-1001');
      expect(second).toEqual<Order | null>(first);
    });
  });
}
