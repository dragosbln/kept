// HAND-WRITTEN (block 4): the matrix fold. The names below are the
// invariants the sketch pins; the bodies land with the fold. The harness
// is literal: a SuiteReport and EvalCase list built in the test, no runner.
// Failing paths first: a fold that counts another assertion's reds, or
// that treats a never-failed assertion as undefined, is the false green.

import { describe, it } from 'vitest';

describe('matrixEntryVerdict', () => {
  it.todo('expected red, red in one of three runs: as-expected');
  it.todo('expected red, red in every run: as-expected');
  it.todo('expected red, never red: missed-red');
  it.todo('expected green, never red: as-expected');
  it.todo('expected green, red in one of three runs: unexpected-red');
});

describe('faultMatrixResult', () => {
  it.todo('one entry per assertion of every case, in case order then assertion order');
  it.todo('an assertion expects red when any toggle it lists is active, green otherwise');
  it.todo('with no active toggle every assertion expects green');
  it.todo(
    'red runs are counted per assertion id: another assertion’s reds in the same case count for nothing',
  );
  it.todo('an assertion that never failed counts zero red runs, not undefined');
  it.todo('errored runs count for nothing; `runs` still counts them');
  it.todo('a case with verdict error has every entry void, and voids never fail the matrix');
  it.todo('a quarantined case is folded and flagged, and its mismatches never fail the matrix');
  it.todo('passed is false on any gating missed-red or unexpected-red');
  it.todo('a case in the report but not in the list, or the reverse, throws naming the case id');
});
