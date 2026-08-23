import type { CompletedTrace } from '../types.js';

/**
 * Write-side sink for completed traces (ADR 0001: Langfuse is a sink for
 * humans, not a source for machines — nothing in-process ever reads back).
 *
 * The contract every implementation must honor:
 *
 * - export() is fire-and-forget and must not throw or reject into the
 *   caller: tracing must never take down the agent loop.
 * - Delivery is best-effort, at-most-once. Failures are reported through
 *   the implementation's own channel, never propagated.
 * - flush() resolves once every export accepted before the call has
 *   settled (delivered or failed); exports started after the flush() call
 *   are not awaited. Call it before process exit to avoid dropping the
 *   tail of the queue.
 */
export interface TraceExporter {
  export(input: CompletedTrace): void;
  flush(): Promise<void>;
}
