// HAND-WRITTEN (block 3): one describe per assertion kind, the invariant
// each pins. The harness is a hand-built Observation with scripted traces
// (CompletedTrace literals) and ledger records; no runner involved.

import { describe, expect, it } from 'vitest';
import { ASSERTIONS } from './registry.js';
import { FAULT_TOGGLES } from '../case/schema.js';

describe('the registry', () => {
  it('has one entry per assertion kind the schema knows, and the toggle vocabulary is the plan’s five', () => {
    expect(Object.keys(ASSERTIONS).toSorted()).toEqual(
      [
        'composed_cap_sum',
        'ledger_records',
        'no_model_call_after_takeover',
        'no_write_before_call',
        'policy_decision',
        'reply_contains',
        'reply_not_contains',
        'retrieval_verdict',
        'retrieved_sections',
        'tool_call_sequence',
        'tool_calls',
        'turn_outcome',
      ].toSorted(),
    );
    expect(FAULT_TOGGLES).toHaveLength(5);
  });
});

describe('tool_call_sequence', () => {
  it.todo('passes when the tools appear in this order as a subsequence of the addressed calls');
  it.todo('fails, naming the first tool out of order, when they do not');
  it.todo('without `at` reads the whole run in step order');
});

describe('tool_calls', () => {
  it.todo('counts tool_execution spans matching tool, state and an args subset');
  it.todo('an args subset matches when every named argument is deeply equal');
  it.todo('the count bounds eq, gte and lte are all checked');
});

describe('no_write_before_call', () => {
  it.todo('passes when every write call has an earlier call of mustFollow');
  it.todo('with sharedArg, the earlier call must carry the same value for that argument');
  it.todo('fails naming the write call id that had no preceding call');
});

describe('ledger_records', () => {
  it.todo('counts records matching orderId, orderItemId, quantity and any of the statuses');
  it.todo('an empty where counts every record');
});

describe('policy_decision', () => {
  it.todo('finds the policy_decision span whose request matches the selector, first or last');
  it.todo('checks the outcome, and the reason only when one is expected');
  it.todo('fails when no decision was made for the selector');
});

describe('composed_cap_sum', () => {
  it.todo(
    'sums counting records (COUNTING_STATUSES) in the cap’s scope and one currency, like the ledger does',
  );
  it.todo(
    'per_call checks each record alone; per_order by orderId; per_customer by the key of the email; per_day everything',
  );
  it.todo('windowed kinds count from clockAtEnd minus the declared window');
  it.todo(
    'compares against the DECLARED cap, so a toggle that filters the engine’s config still turns this red',
  );
  it.todo('a declared cap missing for the kind and currency is a failure that says so');
});

describe('retrieval_verdict', () => {
  it.todo('reads the first, last or every retrieval span of the addressed turn(s)');
  it.todo('fails when the addressed turn(s) have no retrieval span');
});

describe('retrieved_sections', () => {
  it.todo(
    'counts chunks that cleared the threshold, never dropped ones, matching docId, sectionRef and tier',
  );
});

describe('reply_contains / reply_not_contains', () => {
  it.todo('reads the reply of the addressed turn, the last turn of the run by default');
  it.todo('matches case-insensitively; mode all needs every string, mode any needs one');
  it.todo('a turn without a reply fails reply_contains and passes reply_not_contains');
});

describe('turn_outcome', () => {
  it.todo('checks the type, and the failure reason only when one is expected');
});

describe('no_model_call_after_takeover', () => {
  it.todo(
    'passes when no trace of the conversation started after its take-over holds a model_call span',
  );
  it.todo('fails when the conversation was never taken over');
});
