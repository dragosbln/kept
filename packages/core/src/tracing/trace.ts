import { ModelCallSpan, ToolExecutionSpan, TurnSpan, type SpanBase } from './span.js';
import type {
  CompletedTrace,
  StartModelCallPayload,
  StartToolExecutionPayload,
  StartTurnPayload,
  TraceConfig,
  TracePayload,
} from './types.js';

export class Trace {
  private payload: TracePayload;
  private spans: SpanBase[] = [];
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

  startModelCallSpan(parentSpanId: string | null, payload: StartModelCallPayload): ModelCallSpan {
    const span = new ModelCallSpan(this.payload.id, parentSpanId, payload);
    this.spans.push(span);
    return span;
  }

  startToolExecutionSpan(
    parentSpanId: string | null,
    payload: StartToolExecutionPayload,
  ): ToolExecutionSpan {
    const span = new ToolExecutionSpan(this.payload.id, parentSpanId, payload);
    this.spans.push(span);
    return span;
  }

  startTurnSpan(parentSpanId: string | null, payload: StartTurnPayload): TurnSpan {
    const span = new TurnSpan(this.payload.id, parentSpanId, payload);
    this.spans.push(span);
    return span;
  }

  /** Idempotent: the first call freezes the trace; later calls return it. */
  end(): CompletedTrace {
    if (this.completedTrace) return this.completedTrace;
    const completed: CompletedTrace = {
      ...this.payload,
      duration: performance.now() - this.startMark,
      spans: this.spans.map((span) => span.finalize()),
    };
    this.completedTrace = completed;
    return completed;
  }
}
