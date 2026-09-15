import type { ErrorType } from '../messages.js';
import type {
  CompletedSpanPayload,
  EndModelCallPayload,
  EndPolicyDecisionPayload,
  EndToolExecutionPayload,
  EndTurnPayload,
  ModelCallPayload,
  ModelCallSpanPayload,
  PolicyDecisionPayload,
  PolicyDecisionSpanPayload,
  SettledSpanStatus,
  SpanPayload,
  SpanPayloadBase,
  SpanStatus,
  StartModelCallPayload,
  StartPolicyDecisionPayload,
  StartToolExecutionPayload,
  StartTurnPayload,
  ToolExecutionPayload,
  ToolExecutionSpanPayload,
  TurnPayload,
  TurnSpanPayload,
} from './types.js';

/**
 * Wall-clock time with sub-millisecond precision: the monotonic clock read
 * against the process's epoch origin. Date.now() is whole milliseconds, and
 * that was enough to mislead Langfuse's agent graph, which infers steps from
 * timing: a tool span starting on the same millisecond its model call ended
 * reads as parallel to it, and two parallel tool calls whose durations round
 * to zero read as sequential. Spans and traces both stamp from here so the
 * ordering the loop produced survives into the export.
 */
export function wallClockNow(): number {
  return performance.timeOrigin + performance.now();
}

/**
 * Lifecycle + payload protocol, written once. The four parameters mirror
 * the payload partition in types.ts:
 *
 *   TFull  — the complete payload (End fields optional)
 *   TStart — the subset knowable when the span opens
 *   TEnd   — the subset knowable only once the work is done
 *   TError - the particular set of errors a span can produce
 *
 * `TStart extends TFull` holds because every End field is optional in the
 * full payload. If an End field is ever made required, the partition is
 * broken — and the subclass's `extends` clause stops compiling. The
 * constraint IS the partition invariant, checked by the compiler.
 */
export abstract class SpanBase<
  TFull,
  TStart extends TFull,
  TEnd extends Partial<TFull>,
  TError extends ErrorType = ErrorType,
> {
  protected basePayload: SpanPayloadBase;
  protected payload: TFull;
  private startMark: number; // monotonic twin of basePayload.startedAt

  constructor(traceId: string, parentSpanId: string | null, payload: TStart) {
    this.basePayload = {
      id: crypto.randomUUID(),
      traceId,
      parentId: parentSpanId,
      startedAt: wallClockNow(),
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

  error(type: TError): void {
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

/**
 * error() is not callable on TurnSpan (enforced by TError = never).
 * A turn always ends as "completed" with an outcome. The outcome can be "failed".
 * The exact failure (when one exists) lies with the model/tool span where the failure originated
 * */
export class TurnSpan extends SpanBase<TurnPayload, StartTurnPayload, EndTurnPayload, never> {
  snapshot(): TurnSpanPayload {
    return {
      kind: 'turn',
      ...this.basePayload,
      ...this.payload,
    };
  }
}

/**
 * A tool's consultation of the policy engine: opened before the ledger's
 * atomic operation, ended with its decision, so the duration covers the
 * read, the decision and the write. error() is for a consultation that never
 * produced a decision, a throw between open and end.
 */
export class PolicyDecisionSpan extends SpanBase<
  PolicyDecisionPayload,
  StartPolicyDecisionPayload,
  EndPolicyDecisionPayload
> {
  snapshot(): PolicyDecisionSpanPayload {
    return {
      kind: 'policy_decision',
      ...this.basePayload,
      ...this.payload,
    };
  }
}

/** Any span handle a Trace can hold — the closed set matching SpanKindPayload. */
export type AnySpan = ModelCallSpan | ToolExecutionSpan | TurnSpan | PolicyDecisionSpan;
