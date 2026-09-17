import { z } from 'zod';
import { refundAmountFor, sanitizeOrderForModel, type OrderBackend } from '../backend/index.js';
import type { ToolRegistry, ToolResult } from './types.js';
import { defineTool, presentOrderForModel, presentRefundForModel, settle } from './utils.js';
import {
  customerKeyFor,
  type RecordRefundResult,
  type RefundLedger,
} from '../refund-ledger/index.js';
import type { PolicyEngine } from '../policy/engine.js';
import type { PolicyRequest } from '../policy/types.js';
import { executeRefund, type RefundExecution } from '../refunds/execute.js';

const LookupOrderInputSchema = z.object({ orderId: z.string() });

const IssueRefundInputSchema = z.object({
  orderId: z.string(),
  orderItemId: z.string(),
  quantity: z.number(),
});

/** The execution as the model reads it. Only the backend's ok answer is presented in detail. */
function presentExecution(execution: RefundExecution): ToolResult {
  switch (execution.status) {
    case 'not_attempted':
      return settle.failed(
        'Refund not issued: the request is not in a state that can be executed. Do not retry with the same arguments.',
        { ledgerStatus: execution.ledgerStatus },
      );
    case 'settled': {
      const { backendResponse, ledgerRecord } = execution;
      switch (backendResponse.status) {
        case 'ok':
          return settle.ok(
            `Refund executed successfully: ${JSON.stringify(presentRefundForModel(ledgerRecord, backendResponse))}`,
            ledgerRecord,
          );
        case 'failed':
          return settle.failed(`Refund failed: ${backendResponse.errorType}`, {
            error: backendResponse.error,
            ledgerRecord,
          });
        case 'unknown':
          return settle.unknown('Refund state unknown; it may have been issued.', ledgerRecord);
        default:
          backendResponse satisfies never;
          return settle.unknown('Refund state unknown; it may have been issued.', ledgerRecord);
      }
    }
    case 'unknown':
      return settle.unknown(
        execution.ledgerRecord
          ? 'Refund state unknown; it may have been issued.'
          : 'Refund state unknown and could not be recorded; it may have been issued.',
        execution,
      );
    default:
      execution satisfies never;
      return settle.unknown('Refund state unknown; it may have been issued.', execution);
  }
}

/**
 * A deny as the model reads it: the reason as a code, never the caps or the
 * amounts behind it. Already-requested is worded so the customer hears
 * "being handled", not "not eligible".
 */
function presentDeny(decided: Extract<RecordRefundResult, { outcome: 'deny' }>): ToolResult {
  switch (decided.reason) {
    case 'already_requested':
      return settle.failed(
        'Refund denied: a refund for this item is already recorded or under review. Do not retry for this item; tell the customer it is being handled.',
        decided.record,
      );
    case 'not_eligible': {
      const failures = decided.record.eligibility
        .filter((verdict) => !verdict.passed)
        .map((verdict) => verdict.reason);
      return settle.failed(
        `Refund denied, not eligible: ${failures.join(', ')}. Do not retry for this item.`,
        decided.record,
      );
    }
    default:
      decided.reason satisfies never;
      return settle.failed('Refund denied. Do not retry for this item.', decided.record);
  }
}

/**
 * The queue write succeeded, the refund did not happen. `ok` because the
 * tool's own effect is done; the text carries the distinction, and so do
 * the pending record and the decision span. A failed state would reach
 * Anthropic as is_error, which is the reflex that produces apologies and a
 * second attempt.
 */
const APPROVAL_RESPONSE =
  'Refund request recorded; the refund was NOT issued. It requires human approval. Do not retry and do not split the request. Tell the customer a person will review it; do not promise the refund.';

export function createToolRegistry(
  backend: OrderBackend,
  ledger: RefundLedger,
  policyEngine: PolicyEngine,
): ToolRegistry {
  return {
    lookup_order: defineTool({
      description: 'Use to find customer order',
      inputSchema: LookupOrderInputSchema,
      execute: async (input) => {
        const order = await backend.findOrder(input.orderId);

        if (!order) {
          return settle.failed('Order not found');
        }

        const sanitizedOrder = sanitizeOrderForModel(order);

        return settle.ok(JSON.stringify(presentOrderForModel(sanitizedOrder)), sanitizedOrder);
      },
    }),
    issue_refund: defineTool({
      description:
        'Issue a refund for one order item line, by quantity. Policy is enforced by the system: the result says whether the refund was executed, queued for human approval, or denied, and what to tell the customer.',
      inputSchema: IssueRefundInputSchema,
      execute: async (input, ctx) => {
        if (input.quantity <= 0 || !Number.isInteger(input.quantity)) {
          return settle.failed('Invalid quantity: must be a positive integer');
        }

        const order = await backend.findOrder(input.orderId);
        if (!order) {
          return settle.failed('Order not found');
        }

        const orderItem = order.items.find((it) => it.id === input.orderItemId);
        if (!orderItem) {
          return settle.failed(
            `Order item with id ${input.orderItemId} does not exist in the order`,
          );
        }

        const customerKey = customerKeyFor(order);
        const amount = refundAmountFor(order, input.orderItemId, input.quantity);
        const request: PolicyRequest = {
          action: 'issue_refund',
          customerKey,
          orderId: input.orderId,
          orderItemId: input.orderItemId,
          quantity: input.quantity,
          ...amount,
        };

        // Zone 1, under the decision span. A throw here settles as failed in
        // the executor, which is right: nothing has been written. The span
        // must not be left for the sweep, so it is errored and the throw
        // passes through.
        const decisionSpan = ctx.startPolicyDecisionSpan({
          request,
          configHash: policyEngine.configHash,
        });
        let decided: RecordRefundResult;
        try {
          const plan = policyEngine.plan(request, sanitizeOrderForModel(order));
          decided = await ledger.recordRefund(
            {
              conversationId: ctx.conversationId,
              callId: ctx.callId,
              promptHash: ctx.promptHash,
              orderId: input.orderId,
              orderItemId: input.orderItemId,
              quantity: input.quantity,
              customerKey,
              ...amount,
            },
            plan.entries.map((entry) => entry.query),
            // The closure keeps the ledger ignorant of the engine: it hands
            // back result lists, the engine reads the plan.
            (results) => policyEngine.decide(plan, results),
          );
        } catch (error) {
          decisionSpan.error('decision_failed');
          throw error;
        }
        decisionSpan.end({
          outcome: decided.outcome,
          decision: decided.record,
          ...(decided.outcome === 'allow' ? {} : { reason: decided.reason }),
        });

        switch (decided.outcome) {
          case 'deny':
            return presentDeny(decided);
          case 'require_approval':
            return settle.ok(APPROVAL_RESPONSE, {
              decision: decided.record,
              ledgerRecord: decided.ledgerRecord,
            });
          case 'allow':
            return presentExecution(await executeRefund(decided.ledgerRecord, ledger, backend));
          default:
            decided satisfies never;
            return settle.failed('Refund not issued. Do not retry for this item.');
        }
      },
    }),
  };
}
