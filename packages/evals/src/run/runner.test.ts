// HAND-WRITTEN (block 3): the run loop and the stability rule. The names
// below are the invariants the sketch pins; the bodies land with the
// runner. A fake factory over an in-memory agent is the intended harness:
// no model, no Postgres, the trace and the ledger scripted per test.

import { describe, it } from 'vitest';

describe('runOnce', () => {
  it.todo(
    'builds a fresh world per run: the factory is called once, with the materialized fixtures and a clock at the case clock',
  );
  it.todo(
    'maps each customer turn to the trace exported during that call, by conversation ordinal and turn',
  );
  it.todo('opens a conversation the first time its ordinal appears and continues it afterwards');
  it.todo('jump_clock advances the clock the factory received and nothing else');
  it.todo(
    'an operator step resolves its selector against the live ledger and calls the inbox with the actor',
  );
  it.todo(
    'a take-over is recorded with the conversation ordinal, the turns it had so far, and the run clock',
  );
  it.todo('the observation is taken once after the last step and every assertion runs against it');
  it.todo('a factory throw is an error of kind boot_failed');
  it.todo(
    'a turn that fails with reason internal is an error of kind turn_internal; max_rounds and refusal are assertable outcomes',
  );
  it.todo('an inbox refusal on an operator step is an error of kind step_refused');
  it.todo('anything else thrown is an error of kind unexpected, and the agent is still shut down');
  it.todo(
    'the outcome carries every assertion, passed ones included, and the trace ids of the run',
  );
});

describe('resolveRefund', () => {
  it.todo('exactly one record matching the selector among the given statuses is returned');
  it.todo('zero matches is a RunFailure of kind selector_unresolved that names the selector');
  it.todo('several matches is a RunFailure of kind selector_unresolved that says how many');
});

describe('buildObservation', () => {
  it.todo('lists the ledger once and copies the transcript; nothing in the observation is a port');
  it.todo('carries the declared policy from the case and the effective policy from the handle');
  it.todo('the clock at the end is the clock after the last step');
});

describe('verdictFor (the stability rule)', () => {
  it.todo('every run passed is passed');
  it.todo('every run failed is failed');
  it.todo('any disagreement between passed and failed is flaky');
  it.todo('any errored run voids the case: the verdict is error whatever the other runs did');
  it.todo('no runs is an error, not a pass');
});

describe('runCase', () => {
  it.todo('runs the case config.runs times, each in a fresh world');
  it.todo('folds the runs with verdictFor and keeps every run outcome');
});

describe('runSuite', () => {
  it.todo('runs every case in order and returns one outcome per case');
  it.todo('a quarantined case runs and is reported with quarantined: true');
  it.todo('stamps the config and the start and finish times on the report');
});
