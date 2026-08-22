// @kept-hq/core — public surface.
//
// Everything exported here is hand-written per the learning contract in
// CLAUDE.local.md: the trace layer (below), then the agent loop, tool
// schemas and the policy engine, idempotency and tool-result states, the
// retrieval core, and every fault toggle.
//
// Re-export from here as each module lands.

export * from './tracing/index.js';
