// Unit tests for the registry → wire-format translation. What matters is
// that the model is offered exactly what the loop can execute: every
// registry key becomes one definition, and the Zod schema renders as a
// plain JSON Schema object the provider API accepts.

import { describe, expect, it } from 'vitest';
import { toModelToolRegistry } from './utils.js';
import { createToolRegistry } from '../tools/registry.js';
import { DEFAULT_POLICY_CONFIG, PolicyEngine } from '../policy/index.js';
import type { OrderBackend } from '../backend/order-backend.js';
import type { RefundLedger } from '../refund-ledger/index.js';

const unreachableBackend: OrderBackend = {
  findOrder: () => {
    throw new Error('wire-format translation must never execute tools');
  },
  issueRefund: () => {
    throw new Error('wire-format translation must never execute tools');
  },
};

const unreachableLedger: RefundLedger = {
  recordRefund: () => {
    throw new Error('wire-format translation must never execute tools');
  },
  settleRefundRecord: () => {
    throw new Error('wire-format translation must never execute tools');
  },
  updateRefundRecordStatus: () => {
    throw new Error('wire-format translation must never execute tools');
  },
  findRecord: () => {
    throw new Error('wire-format translation must never execute tools');
  },
  list: () => {
    throw new Error('wire-format translation must never execute tools');
  },
};

/** The `properties` map of a rendered JSON Schema, typed for reading descriptions. */
const properties = (schema: Record<string, unknown>): Record<string, { description?: string }> =>
  schema['properties'] as Record<string, { description?: string }>;

describe('toModelToolRegistry', () => {
  const definitions = toModelToolRegistry(
    createToolRegistry(
      unreachableBackend,
      unreachableLedger,
      new PolicyEngine(DEFAULT_POLICY_CONFIG),
    ),
  );

  it('emits one definition per registry entry, named by its key', () => {
    expect(definitions.map((d) => d.name)).toEqual(['lookup_order', 'issue_refund']);
  });

  it('passes the description through', () => {
    expect(definitions[0]!.description).toBe('Use to find customer order');
  });

  it('renders the Zod schema as a JSON Schema object', () => {
    expect(definitions[0]!.inputSchema).toMatchObject({
      type: 'object',
      properties: { orderId: { type: 'string' } },
      required: ['orderId'],
    });
  });

  it('carries the field descriptions into the JSON Schema, where the model reads them', () => {
    // Small models strip id prefixes when the schema leaves them to guess;
    // the description is the fix, so its absence on the wire is a regression.
    expect(properties(definitions[0]!.inputSchema)['orderId']?.description).toContain(
      'exactly as the customer wrote it',
    );
    expect(properties(definitions[1]!.inputSchema)['orderItemId']?.description).toContain(
      'lookup_order',
    );
  });

  it('renders the refund schema with its three required fields', () => {
    expect(definitions[1]!.inputSchema).toMatchObject({
      type: 'object',
      properties: {
        orderId: { type: 'string' },
        orderItemId: { type: 'string' },
        quantity: { type: 'number' },
      },
      required: ['orderId', 'orderItemId', 'quantity'],
    });
  });

  it('emits plain serializable data, not Zod internals', () => {
    const roundTripped: unknown = JSON.parse(JSON.stringify(definitions));
    expect(roundTripped).toEqual(definitions);
  });
});
