import { z } from 'zod';
import {
  refundAmountFor,
  sanitizeOrderForModel,
  type IssueRefundResponse,
  type OrderBackend,
} from '../backend/index.js';
import type { ToolRegistry } from './types.js';
import { defineTool, presentOrderForModel, presentRefundForModel } from './utils.js';
import { LedgerError, customerKeyFor, type RefundLedger } from '../refund-ledger/index.js';

const LookupOrderInputSchema = z.object({ orderId: z.string() });

const IssueRefundInputSchema = z.object({
  orderId: z.string(),
  orderItemId: z.string(),
  quantity: z.number(),
});

export function createToolRegistry(backend: OrderBackend, ledger: RefundLedger): ToolRegistry {
  return {
    lookup_order: defineTool({
      description: 'Use to find customer order',
      inputSchema: LookupOrderInputSchema,
      execute: async (input) => {
        const order = await backend.findOrder(input.orderId);

        if (!order) {
          return {
            resultState: 'failed',
            result: null,
            response: 'Order not found',
          };
        }

        const sanitizedOrder = sanitizeOrderForModel(order);

        return {
          resultState: 'ok',
          result: sanitizedOrder,
          response: JSON.stringify(presentOrderForModel(sanitizedOrder)),
        };
      },
    }),
    issue_refund: defineTool({
      description: 'Use to issue a refund for one order item line (takes quantity as an argument)',
      inputSchema: IssueRefundInputSchema,
      execute: async (input, ctx) => {
        if (input.quantity <= 0 || !Number.isInteger(input.quantity)) {
          return {
            resultState: 'failed',
            result: null,
            response: 'Invalid quantity: must be a positive integer',
          };
        }

        const order = await backend.findOrder(input.orderId);

        if (!order) {
          return {
            resultState: 'failed',
            result: null,
            response: 'Order not found',
          };
        }

        const orderItem = order.items.find((it) => it.id === input.orderItemId);
        if (!orderItem) {
          return {
            resultState: 'failed',
            result: null,
            response: `Order item with id ${input.orderItemId} does not exist in the order`,
          };
        }

        // later: policy engen goes here

        const ledgerRecord = await ledger.recordRefund({
          conversationId: ctx.conversationId,
          callId: ctx.callId,
          promptHash: ctx.promptHash,
          orderId: input.orderId,
          orderItemId: input.orderItemId,
          quantity: input.quantity,
          customerKey: customerKeyFor(order),
          requireApproval: false,
          ...refundAmountFor(order, input.orderItemId, input.quantity),
        });

        let backendResponse: IssueRefundResponse | null = null;

        try {
          backendResponse = await backend.issueRefund({
            // Placeholder until the idempotency work: the ledger record names
            // the decision, so its id is the key that identifies this write.
            // The call id is a different fact (which model request asked).
            key: ledgerRecord.id,
            orderId: input.orderId,
            orderItemId: input.orderItemId,
            quantity: input.quantity,
          });

          const updatedLedgerRecord = await ledger.settleRefundRecord(
            ledgerRecord.id,
            backendResponse,
          );

          switch (backendResponse.status) {
            case 'ok':
              return {
                resultState: 'ok',
                result: updatedLedgerRecord,
                response: `Refund executed succesfully: ${JSON.stringify(presentRefundForModel(updatedLedgerRecord, backendResponse))}`,
              };
            case 'failed':
              return {
                resultState: 'failed',
                result: { error: backendResponse.error, updatedLedgerRecord },
                response: `Refund failed: ${backendResponse.errorType}`,
              };
            case 'unknown':
              return {
                resultState: 'unknown',
                result: updatedLedgerRecord,
                response: 'Refund state unkown. It might have been issued. Do not retry',
              };
          }
        } catch (error) {
          return {
            resultState: 'unknown',
            result: { error, ledgerRecord, backendResponse },
            response:
              error instanceof LedgerError
                ? 'Failed to update records. Refund may have been issued. Do not retry.'
                : 'Refund failed with unknown state. Do not retry',
          };
        }
      },
    }),
  };
}
