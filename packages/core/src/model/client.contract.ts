// The ModelClient contract: one suite, every provider. What it pins is the
// NORMALIZATION semantics — whatever dialect the provider speaks, the client
// must return the same CallModelResponse for the same situation. Each
// provider's test file supplies a harness that fakes its own wire format
// (at the fetch level, so the real SDK parse path is exercised) and maps
// each scenario below to a canned response; this suite asserts the
// normalized result. Provider-specific request-shape assertions (what goes
// OUT on the wire) belong in the per-provider test files, not here.
//
// The cardinal invariant: callModel never rejects. Errors become variants.

import { describe, expect, it } from 'vitest';
import type { Message } from '../messages.js';
import type { ModelClient } from './client.js';
import type { CallModelResponse } from './types.js';

// --- Canonical expectations -------------------------------------------------
// Harnesses must encode these exact values into their wire fixtures so the
// contract can assert on them.

export const contractReplyText = 'Your order shipped yesterday and arrives Tuesday.';

export const contractUsage = { inputTokens: 120, outputTokens: 45 };

export const contractToolCalls = [
  { id: 'call-1', name: 'lookup_order', args: { orderId: 'order-1001' } },
  { id: 'call-2', name: 'lookup_order', args: { orderId: 'order-1002' } },
];

/** The history every scenario is invoked with. */
export const contractCustomerTurn: Message[] = [
  { role: 'user', parts: [{ type: 'text', content: 'Where is my order?' }] },
];

// --- Scenarios --------------------------------------------------------------

export const modelClientScenarios = [
  'replies_with_text',
  'requests_parallel_tools',
  'hits_max_tokens',
  'refuses',
  'unknown_stop_reason',
  'context_overflow_request', // prompt rejected up front (an API error)
  'context_overflow_generation', // window hit mid-generation (a response) — not every provider has this
  'times_out',
  'server_error',
  'network_failure',
] as const;

export type ModelClientScenario = (typeof modelClientScenarios)[number];

export type ModelClientHarness = {
  /** Build a client whose faked transport will produce the given scenario. */
  makeClient(scenario: ModelClientScenario): ModelClient;
  /** Scenarios this provider cannot express (skipped, visibly). */
  unsupported?: ModelClientScenario[];
};

// --- The contract -----------------------------------------------------------

export function describeModelClientContract(name: string, harness: ModelClientHarness): void {
  const scenarioIt = (scenario: ModelClientScenario): typeof it | typeof it.skip =>
    harness.unsupported?.includes(scenario) ? it.skip : it;

  const call = (scenario: ModelClientScenario): Promise<CallModelResponse> =>
    harness.makeClient(scenario).callModel(contractCustomerTurn);

  describe(`ModelClient contract: ${name}`, () => {
    scenarioIt('replies_with_text')(
      'classifies a plain reply as end_turn with the text and usage intact',
      async () => {
        const result = await call('replies_with_text');
        expect(result.type).toBe('end_turn');
        if (result.type !== 'end_turn') return;
        expect(result.message.role).toBe('assistant');
        expect(result.message.parts).toEqual([{ type: 'text', content: contractReplyText }]);
        expect(result.usage).toEqual(contractUsage);
      },
    );

    scenarioIt('requests_parallel_tools')(
      'classifies tool requests as tool_use, preserving every call id, name, and args object',
      async () => {
        const result = await call('requests_parallel_tools');
        expect(result.type).toBe('tool_use');
        if (result.type !== 'tool_use') return;
        const calls = result.message.parts.filter((part) => part.type === 'tool_call');
        expect(calls).toEqual(
          contractToolCalls.map((expected) => ({
            type: 'tool_call',
            id: expected.id,
            name: expected.name,
            args: expected.args,
          })),
        );
      },
    );

    scenarioIt('hits_max_tokens')(
      'classifies a truncated response as max_tokens, keeping the partial message for the trace',
      async () => {
        const result = await call('hits_max_tokens');
        expect(result.type).toBe('max_tokens');
        if (result.type !== 'max_tokens') return;
        expect(result.message.role).toBe('assistant');
        expect(result.usage).toEqual(contractUsage);
      },
    );

    scenarioIt('refuses')('classifies a refusal as refusal, never throwing', async () => {
      const result = await call('refuses');
      expect(result.type).toBe('refusal');
    });

    scenarioIt('unknown_stop_reason')(
      'routes unexpected stop reasons to unknown with the raw reason recorded',
      async () => {
        const result = await call('unknown_stop_reason');
        expect(result.type).toBe('unknown');
        if (result.type !== 'unknown') return;
        expect(result.stopReason.length).toBeGreaterThan(0);
      },
    );

    scenarioIt('context_overflow_request')(
      'classifies a rejected-oversized-prompt error as context_window_exceeded',
      async () => {
        const result = await call('context_overflow_request');
        expect(result.type).toBe('context_window_exceeded');
      },
    );

    scenarioIt('context_overflow_generation')(
      'classifies a mid-generation window overflow as context_window_exceeded with the partial kept',
      async () => {
        const result = await call('context_overflow_generation');
        expect(result.type).toBe('context_window_exceeded');
        if (result.type !== 'context_window_exceeded') return;
        expect(result.message).toBeDefined();
        expect(result.usage).toEqual(contractUsage);
      },
    );

    scenarioIt('times_out')('classifies a timeout as transport_error/timeout', async () => {
      const result = await call('times_out');
      expect(result).toMatchObject({ type: 'transport_error', errorType: 'timeout' });
    });

    scenarioIt('server_error')(
      'classifies an HTTP 500 as transport_error with the status as errorType',
      async () => {
        const result = await call('server_error');
        expect(result).toMatchObject({ type: 'transport_error', errorType: '500' });
      },
    );

    scenarioIt('network_failure')(
      'classifies a connection failure as transport_error/_OTHER carrying a real Error',
      async () => {
        const result = await call('network_failure');
        expect(result).toMatchObject({ type: 'transport_error', errorType: '_OTHER' });
        if (result.type !== 'transport_error') return;
        expect(result.error).toBeInstanceOf(Error);
      },
    );

    it('never rejects: every supported scenario settles to a CallModelResponse', async () => {
      const supported = modelClientScenarios.filter(
        (scenario) => !harness.unsupported?.includes(scenario),
      );
      const results = await Promise.all(supported.map((scenario) => call(scenario)));
      for (const result of results) {
        expect(result.type).toBeDefined();
      }
    });
  });
}
