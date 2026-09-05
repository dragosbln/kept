import { ModelCallSpan, ToolExecutionSpan, TurnSpan, type AnySpan } from './span.js';
import type {
  CompletedTrace,
  StartModelCallPayload,
  StartToolExecutionPayload,
  StartTurnPayload,
  TraceConfig,
  TracePayload,
} from './types.js';

function isDevMode(): boolean {
  // Unset NODE_ENV counts as dev: only an explicit 'production' opts into
  // the silent behavior.
  return process.env['NODE_ENV'] !== 'production';
}

export class Trace {
  private payload: TracePayload;
  private spans: AnySpan[] = [];
  private startMark: number;
  private completedTrace?: CompletedTrace;

  constructor(config: TraceConfig) {
    this.payload = {
      ...config,
      id: crypto.randomUUID(),
      startedAt: Date.now(),
      faultToggles: config.faultToggles ?? [],
    };
    this.startMark = performance.now();
  }

  /**
   * Misuse guard: starting a span on an ended trace is an agent-loop bug —
   * the frozen trace can never record it. Throw where dev runs, tests, and
   * evals will see it; in production stay silent and let the span be
   * dropped, because tracing must never take down a live conversation.
   */
  private guardNotEnded(): void {
    if (this.completedTrace !== undefined && isDevMode()) {
      throw new Error(`trace ${this.payload.id}: span started after end() cannot be recorded`);
    }
  }

  /**
   * Misuse guard: when a trace is finalized, all spans have to be ended; no "in_progress" spans allowed
   * Throw in dev, stay silent in prod
   */
  private guardSpanNotFinalized(span: AnySpan): void {
    if (span.status === 'in_progress' && isDevMode()) {
      throw new Error(
        `span ${span.id}: cannot finalize trace with an unfinished span (in_progress)`,
      );
    }
  }

  startModelCallSpan(parentSpanId: string | null, payload: StartModelCallPayload): ModelCallSpan {
    this.guardNotEnded();
    const span = new ModelCallSpan(this.payload.id, parentSpanId, payload);
    this.spans.push(span);
    return span;
  }

  startToolExecutionSpan(
    parentSpanId: string | null,
    payload: StartToolExecutionPayload,
  ): ToolExecutionSpan {
    this.guardNotEnded();
    const span = new ToolExecutionSpan(this.payload.id, parentSpanId, payload);
    this.spans.push(span);
    return span;
  }

  startTurnSpan(parentSpanId: string | null, payload: StartTurnPayload): TurnSpan {
    this.guardNotEnded();
    const span = new TurnSpan(this.payload.id, parentSpanId, payload);
    this.spans.push(span);
    return span;
  }

  /** Idempotent: the first call freezes the trace; later calls return it. */
  end(): CompletedTrace {
    if (this.completedTrace) return this.completedTrace;
    this.spans.forEach((span) => this.guardSpanNotFinalized(span));
    const completed: CompletedTrace = {
      ...this.payload,
      duration: performance.now() - this.startMark,
      spans: this.spans.map((span) => span.finalize()),
    };
    this.completedTrace = completed;
    return completed;
  }
}
