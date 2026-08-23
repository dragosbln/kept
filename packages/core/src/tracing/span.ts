import type {
  CompletedSpanPayload,
  EndModelCallPayload,
  EndToolExecutionPayload,
  EndTurnPayload,
  ErrorType,
  ModelCallPayload,
  ModelCallSpanPayload,
  SettledSpanStatus,
  SpanPayload,
  SpanPayloadBase,
  SpanStatus,
  StartModelCallPayload,
  StartToolExecutionPayload,
  StartTurnPayload,
  ToolExecutionPayload,
  ToolExecutionSpanPayload,
  TurnPayload,
  TurnSpanPayload,
} from './types.js';

/**
 * Lifecycle + payload protocol, written once. The three parameters mirror
 * the payload partition in types.ts:
 *
 *   TFull  — the complete payload (End fields optional)
 *   TStart — the subset knowable when the span opens
 *   TEnd   — the subset knowable only once the work is done
 *
 * `TStart extends TFull` holds because every End field is optional in the
 * full payload. If an End field is ever made required, the partition is
 * broken — and the subclass's `extends` clause stops compiling. The
 * constraint IS the partition invariant, checked by the compiler.
 */
export abstract class SpanBase<TFull, TStart extends TFull, TEnd extends Partial<TFull>> {
  protected basePayload: SpanPayloadBase;
  protected payload: TFull;
  private startMark: number; // monotonic twin of basePayload.startedAt

  constructor(traceId: string, parentSpanId: string | null, payload: TStart) {
    this.basePayload = {
      id: crypto.randomUUID(),
      traceId,
      parentId: parentSpanId,
      startedAt: Date.now(),
      status: 'in_progress',
    };
    this.payload = payload;
    this.startMark = performance.now();
  }

  get id(): string {
    return this.basePayload.id;
  }

  get status(): SpanStatus {
    return this.basePayload.status;
  }

  abstract snapshot(): SpanPayload;

  /** Idempotent: the first completion wins; later calls are no-ops. */
  protected complete(status: SettledSpanStatus): void {
    if (this.basePayload.status !== 'in_progress') return;
    this.basePayload.duration = performance.now() - this.startMark;
    this.basePayload.status = status;
  }

  /** First completion wins: end() after error(), or a second end(), is a no-op. */
  end(payload: TEnd): void {
    if (this.status !== 'in_progress') return;
    this.payload = { ...this.payload, ...payload };
    this.complete('completed');
  }

  error(type: ErrorType): void {
    if (this.status !== 'in_progress') return;
    this.basePayload.errorType = type;
    this.complete('error');
  }

  abandonIfInProgress(): void {
    this.complete('undetermined');
  }

  /**
   * Sweep hook for Trace.end(): abandons the span if still open, then
   * snapshots. complete() is the only transition out of in_progress and it
   * always stamps duration, so the guard below is unreachable — it exists
   * to fail loudly (and convince TS) rather than emit an unsettled span.
   */
  finalize(): CompletedSpanPayload {
    this.abandonIfInProgress();
    const { status, duration } = this.basePayload;
    if (status === 'in_progress' || duration === undefined) {
      throw new Error(`span ${this.basePayload.id}: still open after sweep`);
    }
    return { ...this.snapshot(), status, duration };
  }
}

export class ModelCallSpan extends SpanBase<
  ModelCallPayload,
  StartModelCallPayload,
  EndModelCallPayload
> {
  snapshot(): ModelCallSpanPayload {
    return {
      kind: 'model_call',
      ...this.basePayload,
      ...this.payload,
    };
  }
}

export class ToolExecutionSpan extends SpanBase<
  ToolExecutionPayload,
  StartToolExecutionPayload,
  EndToolExecutionPayload
> {
  snapshot(): ToolExecutionSpanPayload {
    return {
      kind: 'tool_execution',
      ...this.basePayload,
      ...this.payload,
    };
  }
}

export class TurnSpan extends SpanBase<TurnPayload, StartTurnPayload, EndTurnPayload> {
  snapshot(): TurnSpanPayload {
    return {
      kind: 'turn',
      ...this.basePayload,
      ...this.payload,
    };
  }
}

/** Any span handle a Trace can hold — the closed set matching SpanKindPayload. */
export type AnySpan = ModelCallSpan | ToolExecutionSpan | TurnSpan;
