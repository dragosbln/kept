// The case format: what a valid file becomes, and which mistakes fail at
// load. Pinned:
// - defaults: seed on, actor "eval", conversation 1, expectRedUnder empty,
//   assertion ids from position and kind, the built-in policy
// - the clock parses to epoch ms
// - unknown keys, unknown kinds and duplicate assertion ids are refusals
// - ordinals are checked against the steps: conversations open in order,
//   a take-over needs an open conversation, `at` needs an existing turn
// - composed_cap_sum needs the id its scope reads

import { describe, expect, it } from 'vitest';
import { DEFAULT_POLICY_CONFIG } from '@kept-hq/core';
import { parseEvalCase, parseQuarantine } from './schema.js';

const minimal = {
  id: 'example-case',
  title: 'Example',
  storeId: 'loomhaven',
  clock: '2026-09-10T12:00:00Z',
  steps: [{ kind: 'customer_message', message: 'Is return shipping free?' }],
  assertions: [{ kind: 'retrieval_verdict', verdict: 'grounded' }],
};

describe('parseEvalCase', () => {
  it('fills the defaults and parses the clock', () => {
    const evalCase = parseEvalCase(minimal);
    expect(evalCase.clock).toBe(Date.UTC(2026, 8, 10, 12));
    expect(evalCase.tags).toEqual([]);
    expect(evalCase.fixtures).toEqual({
      seedDemoOrders: true,
      orders: [],
      priorRefunds: [],
      policy: DEFAULT_POLICY_CONFIG,
      backend: {},
    });
    expect(evalCase.steps[0]).toMatchObject({ kind: 'customer_message', conversation: 1 });
    expect(evalCase.assertions[0]).toMatchObject({
      id: '1-retrieval_verdict',
      occurrence: 'last',
      expectRedUnder: [],
    });
  });

  it('keeps an explicit assertion id and refuses a duplicate', () => {
    const withIds = parseEvalCase({
      ...minimal,
      assertions: [
        { id: 'grounded', kind: 'retrieval_verdict', verdict: 'grounded' },
        { id: 'cited', kind: 'reply_contains', strings: ['§6'] },
      ],
    });
    expect(withIds.assertions.map((a) => a.id)).toEqual(['grounded', 'cited']);
    expect(() =>
      parseEvalCase({
        ...minimal,
        assertions: [
          { id: 'same', kind: 'retrieval_verdict', verdict: 'grounded' },
          { id: 'same', kind: 'reply_contains', strings: ['§6'] },
        ],
      }),
    ).toThrow(/duplicate assertion id "same"/);
  });

  it('refuses unknown keys and unknown kinds, naming the source', () => {
    expect(() => parseEvalCase({ ...minimal, clocks: 'x' }, 'a.yaml')).toThrow(/^a\.yaml: /);
    expect(() =>
      parseEvalCase({ ...minimal, assertions: [{ kind: 'reply_has', strings: ['x'] }] }),
    ).toThrow(/kind/);
    expect(() =>
      parseEvalCase({
        ...minimal,
        assertions: [{ kind: 'reply_contains', strings: ['x'], expectedRedUnder: [] }],
      }),
    ).toThrow(/expectedRedUnder/);
  });

  it('conversations open in order, through a customer message', () => {
    const twoConversations = parseEvalCase({
      ...minimal,
      steps: [
        { kind: 'customer_message', conversation: 1, message: 'a' },
        { kind: 'customer_message', conversation: 2, message: 'b' },
        { kind: 'customer_message', conversation: 1, message: 'c' },
        { kind: 'human_takeover', conversation: 2 },
      ],
      assertions: [{ kind: 'no_model_call_after_takeover', conversation: 2 }],
    });
    expect(twoConversations.steps).toHaveLength(4);
    expect(twoConversations.steps[3]).toMatchObject({ kind: 'human_takeover', actor: 'eval' });

    expect(() =>
      parseEvalCase({
        ...minimal,
        steps: [{ kind: 'customer_message', conversation: 2, message: 'a' }],
      }),
    ).toThrow(/conversation 2 opens before conversation 1/);
    expect(() =>
      parseEvalCase({
        ...minimal,
        steps: [
          { kind: 'human_takeover', conversation: 1 },
          { kind: 'customer_message', message: 'a' },
        ],
      }),
    ).toThrow(/has not opened yet/);
  });

  it('`at` must address an existing turn, and a turn needs its conversation', () => {
    const ok = parseEvalCase({
      ...minimal,
      steps: [
        { kind: 'customer_message', message: 'a' },
        { kind: 'customer_message', message: 'b' },
      ],
      assertions: [{ kind: 'reply_contains', strings: ['x'], at: { conversation: 1, turn: 2 } }],
    });
    expect(ok.assertions[0]).toMatchObject({ at: { conversation: 1, turn: 2 }, mode: 'all' });
    expect(() =>
      parseEvalCase({
        ...minimal,
        assertions: [{ kind: 'reply_contains', strings: ['x'], at: { conversation: 1, turn: 2 } }],
      }),
    ).toThrow(/has 1 turn\(s\), not 2/);
    expect(() =>
      parseEvalCase({
        ...minimal,
        assertions: [{ kind: 'reply_contains', strings: ['x'], at: { conversation: 2 } }],
      }),
    ).toThrow(/conversation 2 does not exist/);
    expect(() =>
      parseEvalCase({
        ...minimal,
        assertions: [{ kind: 'reply_contains', strings: ['x'], at: { turn: 1 } }],
      }),
    ).toThrow(/at\.turn needs at\.conversation/);
  });

  it('tool_call_sequence without a conversation is only a shorthand in a one-conversation case', () => {
    const one = parseEvalCase({
      ...minimal,
      assertions: [{ kind: 'tool_call_sequence', tools: ['lookup_order', 'issue_refund'] }],
    });
    expect(one.assertions[0]).toMatchObject({ kind: 'tool_call_sequence' });
    const twoConversations = {
      ...minimal,
      steps: [
        { kind: 'customer_message', conversation: 1, message: 'a' },
        { kind: 'customer_message', conversation: 2, message: 'b' },
      ],
    };
    expect(() =>
      parseEvalCase({
        ...twoConversations,
        assertions: [{ kind: 'tool_call_sequence', tools: ['lookup_order'] }],
      }),
    ).toThrow(/at\.conversation is required/);
    const addressed = parseEvalCase({
      ...twoConversations,
      assertions: [
        { kind: 'tool_call_sequence', tools: ['lookup_order'], at: { conversation: 2 } },
      ],
    });
    expect(addressed.assertions[0]).toMatchObject({ at: { conversation: 2 } });
  });

  it('composed_cap_sum needs the id its scope reads', () => {
    expect(() =>
      parseEvalCase({
        ...minimal,
        assertions: [{ kind: 'composed_cap_sum', cap: 'per_order', currency: 'USD' }],
      }),
    ).toThrow(/per_order needs orderId/);
    expect(() =>
      parseEvalCase({
        ...minimal,
        assertions: [{ kind: 'composed_cap_sum', cap: 'per_customer', currency: 'USD' }],
      }),
    ).toThrow(/per_customer needs email/);
    const perDay = parseEvalCase({
      ...minimal,
      assertions: [{ kind: 'composed_cap_sum', cap: 'per_day', currency: 'EUR' }],
    });
    expect(perDay.assertions[0]).toMatchObject({ cap: 'per_day', currency: 'EUR' });
  });

  it('a count needs a bound, and the policy is the engine’s own schema', () => {
    expect(() =>
      parseEvalCase({ ...minimal, assertions: [{ kind: 'ledger_records', count: {} }] }),
    ).toThrow(/at least one of eq, gte, lte/);
    expect(() =>
      parseEvalCase({
        ...minimal,
        fixtures: {
          policy: {
            version: '1',
            caps: [{ kind: 'per_day', amountMinorUnits: 1, currency: 'USD' }],
          },
        },
      }),
    ).toThrow(/windowMs/);
  });
});

describe('parseQuarantine', () => {
  it('an empty file is an empty list; entries carry the date and the reason', () => {
    expect(parseQuarantine(null)).toEqual([]);
    expect(
      parseQuarantine([{ caseId: 'attack-sympathy', since: '2026-09-24', reason: 'flaked' }]),
    ).toHaveLength(1);
    expect(() => parseQuarantine([{ caseId: 'x', since: 'yesterday', reason: 'r' }])).toThrow(
      /since/,
    );
  });
});
