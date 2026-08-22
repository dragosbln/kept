import type {
  CompletedSpanPayload,
  EndModelCallPayload,
  EndToolExecutionPayload,
  EndTurnPayload,
  ErrorType,
  ModelCallPayload,
  ModelCallSpanPayload,
  SpanPayload,
  SpanPayloadBase,
  SpanStatus,
  StartModelCallPayload,
  StartToolExecutionPayload,
  StartTurnPayload,
  ToolExecutionPayload,
  ToolExecutionSpanPayload,
  TracePayload,
  TurnPayload,
  TurnSpanPayload,
} from './types.js';

export abstract class SpanBase {
  protected basePayload: SpanPayloadBase;
  private startMark: number; // monotonic twin of basePayload.startedAt

  constructor(tracePayload: TracePayload, parentSpanId: string | null) {
    this.basePayload = {
      id: crypto.randomUUID(),
      traceId: tracePayload.id,
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
  protected complete(status: SpanStatus) {
    if (this.basePayload.status !== 'in_progress') return;
    this.basePayload.duration = performance.now() - this.startMark;
    this.basePayload.status = status;
  }

  error(type: ErrorType) {
    if (this.status !== 'in_progress') return;
    this.basePayload.errorType = type;
    this.complete('error');
  }

  abandonIfInProgress() {
    this.complete('undetermined');
  }

  /**
   * Sweep hook for Trace.end(): abandons the span if still open, then
   * snapshots. Only complete() moves status off in_progress and it always
   * stamps duration, so the assertion below is backed by an invariant.
   */
  finalize(): CompletedSpanPayload {
    this.abandonIfInProgress();
    return {
      ...this.snapshot(),
      duration: this.basePayload.duration!,
    };
  }
}

export class ModelCallSpan extends SpanBase {
  private payload: ModelCallPayload;

  constructor(
    tracePayload: TracePayload,
    parentSpanId: string | null,
    payload: StartModelCallPayload,
  ) {
    super(tracePayload, parentSpanId);
    this.payload = payload;
  }

  snapshot(): ModelCallSpanPayload {
    return {
      kind: 'model_call',
      ...this.basePayload,
      ...this.payload,
    };
  }

  end(payload: EndModelCallPayload) {
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

  constructor(
    tracePayload: TracePayload,
    parentSpanId: string | null,
    payload: StartToolExecutionPayload,
  ) {
    super(tracePayload, parentSpanId);
    this.payload = payload;
  }

  snapshot(): ToolExecutionSpanPayload {
    return {
      kind: 'tool_execution',
      ...this.basePayload,
      ...this.payload,
    };
  }

  end(payload: EndToolExecutionPayload) {
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

  constructor(tracePayload: TracePayload, parentSpanId: string | null, payload: StartTurnPayload) {
    super(tracePayload, parentSpanId);
    this.payload = payload;
  }

  snapshot(): TurnSpanPayload {
    return {
      kind: 'turn',
      ...this.basePayload,
      ...this.payload,
    };
  }

  end(payload: EndTurnPayload) {
    if (this.status !== 'in_progress') return;
    this.payload = {
      ...this.payload,
      ...payload,
    };
    this.complete('completed');
  }
}
