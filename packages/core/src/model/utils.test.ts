// Unit tests for the registry → wire-format translation. What matters is
// that the model is offered exactly what the loop can execute: every
// registry key becomes one definition, and the Zod schema renders as a
// plain JSON Schema object the provider API accepts.

import { describe, expect, it } from 'vitest';
import { toModelToolRegistry } from './utils.js';
import { createToolRegistry } from '../tools/registry.js';
import type { OrderBackend } from '../backend/order-backend.js';

const unreachableBackend: OrderBackend = {
  findOrder: () => {
    throw new Error('wire-format translation must never execute tools');
  },
};

describe('toModelToolRegistry', () => {
  const definitions = toModelToolRegistry(createToolRegistry(unreachableBackend));

  it('emits one definition per registry entry, named by its key', () => {
    expect(definitions.map((d) => d.name)).toEqual(['lookup_order']);
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

  it('emits plain serializable data, not Zod internals', () => {
    const roundTripped: unknown = JSON.parse(JSON.stringify(definitions));
    expect(roundTripped).toEqual(definitions);
  });
});
