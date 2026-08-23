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

export abstract class SpanBase {
  protected basePayload: SpanPayloadBase;
  private startMark: number; // monotonic twin of basePayload.startedAt

  constructor(traceId: string, parentSpanId: string | null) {
    this.basePayload = {
      id: crypto.randomUUID(),
      traceId,
      parentId: parentSpanId,
      startedAt: Date.now(),
      status: 'in_progress',
    };
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

export class ModelCallSpan extends SpanBase {
  private payload: ModelCallPayload;

  constructor(traceId: string, parentSpanId: string | null, payload: StartModelCallPayload) {
    super(traceId, parentSpanId);
    this.payload = payload;
  }

  snapshot(): ModelCallSpanPayload {
    return {
      kind: 'model_call',
      ...this.basePayload,
      ...this.payload,
    };
  }

  end(payload: EndModelCallPayload): void {
    if (this.status !== 'in_progress') return;
    this.payload = {
      ...this.payload,
      ...payload,
    };
    this.complete('completed');
  }
}

export class ToolExecutionSpan extends SpanBase {
  private payload: ToolExecutionPayload;

  constructor(traceId: string, parentSpanId: string | null, payload: StartToolExecutionPayload) {
    super(traceId, parentSpanId);
    this.payload = payload;
  }

  snapshot(): ToolExecutionSpanPayload {
    return {
      kind: 'tool_execution',
      ...this.basePayload,
      ...this.payload,
    };
  }

  end(payload: EndToolExecutionPayload): void {
    if (this.status !== 'in_progress') return;
    this.payload = {
      ...this.payload,
      ...payload,
    };
    this.complete('completed');
  }
}

export class TurnSpan extends SpanBase {
  private payload: TurnPayload;

  constructor(traceId: string, parentSpanId: string | null, payload: StartTurnPayload) {
    super(traceId, parentSpanId);
    this.payload = payload;
  }

  snapshot(): TurnSpanPayload {
    return {
      kind: 'turn',
      ...this.basePayload,
      ...this.payload,
    };
  }

  end(payload: EndTurnPayload): void {
    if (this.status !== 'in_progress') return;
    this.payload = {
      ...this.payload,
      ...payload,
    };
    this.complete('completed');
  }
}
