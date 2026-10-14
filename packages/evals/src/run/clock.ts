import type { RunClock } from './types.js';

/** A clock that only moves when a step moves it. Starts at the case clock. */
export function createRunClock(start: number): RunClock {
  let current = start;
  return {
    now: () => current,
    advance: (byMs) => {
      current += byMs;
    },
  };
}
