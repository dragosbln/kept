import { describe, expect, it } from 'vitest';
import { createRunClock } from './clock.js';

describe('createRunClock', () => {
  it('starts at the case clock and moves only when advanced', () => {
    const clock = createRunClock(1_000);
    expect(clock.now()).toBe(1_000);
    expect(clock.now()).toBe(1_000);
    clock.advance(250);
    expect(clock.now()).toBe(1_250);
  });
});
