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

    // The backend owns exactly one invariant on refunds: a positive integer
    // quantity, no larger than what the line contains minus what was already
    // refunded. Everything else — delivery status, caps, approval — is policy
    // and sits in front of this port. The idempotency key names one intended
    // write; the three replay cases are pinned at the end of this block.
    describe('issueRefund', () => {
      it('refunds a line at unit price × quantity, in the order currency', async () => {
        const backend = await makeBackend();
        const response = await backend.issueRefund('contract-refund-1', {
          orderId: 'order-1005',
          orderItemId: 'order-1005-line-1', // 1 × $79.00
          quantity: 1,
        });
        expect(response).toMatchObject({
          status: 'ok',
          amountMinorUnits: 7900,
          currency: 'USD',
          refundId: expect.any(String),
        });
      });

      it('computes the amount from the line, never from the caller', async () => {
        const backend = await makeBackend();
        const response = await backend.issueRefund('contract-refund-2', {
          orderId: 'order-1001',
          orderItemId: 'order-1001-line-2', // Wool Socks, 2 × $45.59
          quantity: 2,
        });
        expect(response).toMatchObject({ status: 'ok', amountMinorUnits: 9118, currency: 'USD' });
      });

      it('does not check delivery: an in-transit line refunds at this layer', async () => {
        // Delivery is a policy rule, enforced in front of the port. A backend
        // that refused here would hide the policy engine's decision.
        const backend = await makeBackend();
        const inTransit = (await backend.findOrder('order-1001'))!;
        expect(inTransit.status).toBe('shipped');
        const response = await backend.issueRefund('contract-refund-3', {
          orderId: 'order-1001',
          orderItemId: 'order-1001-line-1',
          quantity: 1,
        });
        expect(response.status).toBe('ok');
      });

      it('rejects a quantity beyond what the line contains, on the first refund too', async () => {
        const backend = await makeBackend();
        const response = await backend.issueRefund('contract-refund-4', {
          orderId: 'order-1004',
          orderItemId: 'order-1004-line-1', // qty 1
          quantity: 2,
        });
        expect(response).toEqual({ status: 'failed', errorType: 'quantity_exceeds_unrefunded' });
      });

      it('shrinks the refundable quantity with every refund', async () => {
        const backend = await makeBackend();
        const params = {
          orderId: 'order-1002',
          orderItemId: 'order-1002-line-1', // Trail Boots, qty 2
          quantity: 1,
        };
        expect((await backend.issueRefund('contract-refund-5a', params)).status).toBe('ok');
        expect((await backend.issueRefund('contract-refund-5b', params)).status).toBe('ok');
        expect(await backend.issueRefund('contract-refund-5c', params)).toEqual({
          status: 'failed',
          errorType: 'quantity_exceeds_unrefunded',
        });
      });

      it('rejects zero, negative and fractional quantities as invalid', async () => {
        const backend = await makeBackend();
        const quantities = [0, -1, 0.5];
        const responses = await Promise.all(
          quantities.map((quantity) =>
            backend.issueRefund(`contract-refund-6-${quantity}`, {
              orderId: 'order-1005',
              orderItemId: 'order-1005-line-1',
              quantity,
            }),
          ),
        );
        responses.forEach((response, index) => {
          expect(response, `quantity ${quantities[index]}`).toEqual({
            status: 'failed',
            errorType: 'quantity_invalid',
          });
        });
      });

      it('fails, never throws, for unknown orders, unknown lines and degenerate ids', async () => {
        const backend = await makeBackend();
        expect(
          await backend.issueRefund('contract-refund-7a', {
            orderId: 'nope',
            orderItemId: 'order-1005-line-1',
            quantity: 1,
          }),
        ).toEqual({ status: 'failed', errorType: 'order_not_found' });
        expect(
          await backend.issueRefund('contract-refund-7b', {
            orderId: 'order-1005',
            orderItemId: 'order-1004-line-1',
            quantity: 1,
          }),
        ).toEqual({ status: 'failed', errorType: 'line_not_found' });
        expect(
          await backend.issueRefund('', { orderId: '', orderItemId: '', quantity: 1 }),
        ).toMatchObject({ status: 'failed' });
      });

      // The idempotency contract: one key names one intended write.
      it('replays the recorded outcome for the same key and parameters, moving nothing twice', async () => {
        const backend = await makeBackend();
        const params = { orderId: 'order-1002', orderItemId: 'order-1002-line-1', quantity: 1 }; // qty 2
        const first = await backend.issueRefund('contract-key-1', params);
        const replay = await backend.issueRefund('contract-key-1', params);
        expect(first.status).toBe('ok');
        expect(replay).toEqual(first);
        // The replay consumed nothing: the second unit is still there for a new key.
        expect((await backend.issueRefund('contract-key-1b', params)).status).toBe('ok');
        expect(await backend.issueRefund('contract-key-1c', params)).toEqual({
          status: 'failed',
          errorType: 'quantity_exceeds_unrefunded',
        });
      });

      it('remembers a failed outcome per key too', async () => {
        const backend = await makeBackend();
        const params = { orderId: 'order-1004', orderItemId: 'order-1004-line-1', quantity: 2 }; // qty 1
        const first = await backend.issueRefund('contract-key-2', params);
        expect(first).toEqual({ status: 'failed', errorType: 'quantity_exceeds_unrefunded' });
        expect(await backend.issueRefund('contract-key-2', params)).toEqual(first);
      });

      it('refuses the same key with different parameters and never executes it', async () => {
        const backend = await makeBackend();
        const boots = { orderId: 'order-1002', orderItemId: 'order-1002-line-1', quantity: 1 };
        const insoles = { orderId: 'order-1002', orderItemId: 'order-1002-line-2', quantity: 1 }; // qty 1
        expect((await backend.issueRefund('contract-key-3', boots)).status).toBe('ok');
        expect(await backend.issueRefund('contract-key-3', insoles)).toEqual({
          status: 'failed',
          errorType: 'key_conflict',
        });
        // Not executed: the insoles are still refundable under their own key.
        expect((await backend.issueRefund('contract-key-3b', insoles)).status).toBe('ok');
      });

      it('never mutates the canonical order: refunds are recorded beside it, not on it', async () => {
        const backend = await makeBackend();
        const before = structuredClone(await backend.findOrder('order-1005'));
        await backend.issueRefund('contract-refund-8', {
          orderId: 'order-1005',
          orderItemId: 'order-1005-line-1',
          quantity: 1,
        });
        expect(await backend.findOrder('order-1005')).toEqual(before);
      });
    });
  });
}
