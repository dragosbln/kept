import { describe, expect, it } from 'vitest';
import { customerKeyFor } from './customer-key.js';

describe('customerKeyFor', () => {
  it('is stable across casing and whitespace of the same address', () => {
    expect(customerKeyFor({ email: '  Sam@Example.com ' })).toBe(
      customerKeyFor({ email: 'sam@example.com' }),
    );
  });

  it('separates different customers', () => {
    expect(customerKeyFor({ email: 'sam@example.com' })).not.toBe(
      customerKeyFor({ email: 'dana@example.com' }),
    );
  });

  it('never contains the email', () => {
    const key = customerKeyFor({ email: 'sam@example.com' });
    expect(key).not.toContain('sam');
    expect(key).toMatch(/^[0-9a-f]{64}$/);
  });
});
