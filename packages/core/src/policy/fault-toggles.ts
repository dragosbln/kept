// The cap registry is iterated, never branched on, so the toggle is a
// filter over the config and nothing in the engine changes: with every cap
// but `per_call` gone, the per-order, per-customer and per-day sums are
// never computed, and a split refund that respects each call's limit walks
// past the composed limits. The attack cases catch it because their cap-sum
// assertion compares against the caps the case declared, never the ones the
// engine ran with (block 3, the cap-sum decision).

import type { FaultToggle } from '../fault-toggles.js';
import type { PolicyEngineConfig } from './config.js';

/**
 * The config the engine runs with. With no toggle it is the declared config
 * itself, the same object, so the hash the engine computes next is the
 * merchant's. Under `caps-per-call-only` it is the same version with only
 * the `per_call` caps kept. The engine hashes what it runs with: under the
 * toggle the trace's `policyConfigHash` is the effective config's, and the
 * trace carries the toggle list beside it, so a reader can tell why.
 */
export function applyPolicyFaultToggles(
  config: PolicyEngineConfig,
  toggles: readonly FaultToggle[],
): PolicyEngineConfig {
  if (!toggles.includes('caps-per-call-only')) return config;
  return {
    version: config.version,
    caps: config.caps.filter((cap) => cap.kind === 'per_call'),
  };
}
