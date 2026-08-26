// --- Vocabulary -------------------------------------------------------------

import type { Message, ToolArgs, ToolResultState } from '../messages.js';

/**
 * Well-known error classes; the list grows as fault toggles land. `_OTHER`
 * is OTel's conventional fallback for "an error outside the known classes".
 */
export type WellKnownErrorType = 'timeout' | '_OTHER';

/**
 * Low-cardinality error identifier, OTel `error.type` style: prefer a
 * WellKnownErrorType, otherwise any stable identifier (an HTTP status code,
 * an exception class name) — never free-form message text, so errors stay
 * groupable in dashboards and eval assertions.
 */
export type ErrorType = WellKnownErrorType | (string & {});

/** Which commerce backend served the conversation's tools. */
export type BackendKind = 'demo' | 'medusa';

/** Lifecycle of a span. `undetermined` = still open when the trace ended. */
export type SpanStatus = 'in_progress' | 'completed' | 'undetermined' | 'error';

// --- Span payloads ----------------------------------------------------------
// Each span kind splits its fields two ways: the Start subset (knowable when
// the span opens) and the End subset (knowable only once the work is done).
// End is the source of truth; Start is derived from it, so the two always
// partition the full payload.

export type SpanPayloadBase = {
  id: string;
  traceId: string;
  parentId: string | null;
  startedAt: number; // wall clock (epoch ms); duration is measured monotonically
  duration?: number;
  errorType?: ErrorType;
  status: SpanStatus;
};

export type ModelCallPayload = {
  // What this call actually used — the source of truth for eval assertions.
  // The same fields on TracePayload are only a denormalized filter stamp.
  promptName: string;
  promptVersion: string;
  promptHash: string;
  providerName: string;
  model: string;
  temperature: number;
  inputTokens?: number;
  outputTokens?: number;
  inputMessages: Message[];
  outputMessages?: Message[];
};

export type EndModelCallPayload = Pick<
  ModelCallPayload,
  'inputTokens' | 'outputTokens' | 'outputMessages'
>;

export type StartModelCallPayload = Omit<ModelCallPayload, keyof EndModelCallPayload>;

export type ToolExecutionPayload = {
  callId: string;
  toolName: string;
  args: ToolArgs;
  resultState?: ToolResultState;
  result?: unknown;
};

export type EndToolExecutionPayload = Pick<ToolExecutionPayload, 'resultState' | 'result'>;

export type StartToolExecutionPayload = Omit<ToolExecutionPayload, keyof EndToolExecutionPayload>;

export type TurnFailureReason = 'internal' | 'max_turns' | 'refusal' | 'max_tokens';

export type TurnOutcome =
  | {
      type: 'reply';
      message: string;
    }
  | {
      type: 'failed';
      reason: TurnFailureReason;
    }
  | {
      type: 'conversation_full';
    };

export type TurnPayload = {
  customerInput: string;
  outcome?: TurnOutcome;
};

export type EndTurnPayload = Required<Pick<TurnPayload, 'outcome'>>;

export type StartTurnPayload = Omit<TurnPayload, keyof EndTurnPayload>;

/**
 * Compile-time guard: a kind payload must not reuse a SpanPayloadBase field
 * name (or `kind`). A collision would make that SpanPayload union member
 * uninhabited, with TS reporting the error far away on `kind`; this
 * constraint surfaces it here instead, naming the offending payload.
 */
type DisjointFromBase<
  T extends { [K in Extract<keyof T, keyof SpanPayloadBase | 'kind'>]: never },
> = T;

export type SpanKindPayload =
  | ({ kind: 'model_call' } & DisjointFromBase<ModelCallPayload>)
  | ({ kind: 'tool_execution' } & DisjointFromBase<ToolExecutionPayload>)
  | ({ kind: 'turn' } & DisjointFromBase<TurnPayload>);

export type SpanKind = SpanKindPayload['kind'];

/** The exported span shape — the contract eval assertions depend on. */
export type SpanPayload = SpanPayloadBase & SpanKindPayload;

/** Span statuses that can remain once a trace has ended: the sweep closes everything open. */
export type SettledSpanStatus = Exclude<SpanStatus, 'in_progress'>;

/** A span as recorded in a CompletedTrace: swept, so duration is stamped and nothing is still in progress. */
export type CompletedSpanPayload = SpanPayload & {
  duration: number;
  status: SettledSpanStatus;
};

// Narrowed per-kind members, for callers holding a concrete span.
export type ModelCallSpanPayload = Extract<SpanPayload, { kind: 'model_call' }>;
export type ToolExecutionSpanPayload = Extract<SpanPayload, { kind: 'tool_execution' }>;
export type TurnSpanPayload = Extract<SpanPayload, { kind: 'turn' }>;

// --- Trace payloads ---------------------------------------------------------

export type TracePayload = {
  id: string;
  sessionId: string;
  faultToggles: string[];
  startedAt: number;
  duration?: number;
  backendKind: BackendKind;
  // Prompt + provider stamp, denormalized onto the trace as a filter key
  // ("every conversation that ran prompt X"). The authoritative record of
  // what each call actually used lives on its model_call span; the two can
  // disagree once a conversation mixes prompts.
  promptName: string;
  promptVersion: string;
  promptHash: string;
  providerName: string;
};

export type TraceConfig = Pick<
  TracePayload,
  'providerName' | 'promptName' | 'promptVersion' | 'promptHash' | 'sessionId' | 'backendKind'
> &
  Partial<Pick<TracePayload, 'faultToggles'>>;

export type CompletedTrace = TracePayload & {
  duration: number; // optional on TracePayload, but end() always stamps it
  spans: CompletedSpanPayload[];
};
