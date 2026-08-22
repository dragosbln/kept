// --- Vocabulary -------------------------------------------------------------

export type ErrorType = 'timeout' | '500' | '...';

/** Lifecycle of a span. `undetermined` = still open when the trace ended. */
export type SpanStatus = 'in_progress' | 'completed' | 'undetermined' | 'error';

/** Outcome of a tool call — deliberately distinct from SpanStatus. */
export type ToolResultState = 'ok' | 'failed' | 'unknown';

export type MessageRole = 'user' | 'assistant' | 'tool' | 'system';

/** Tool arguments — one shape wherever a tool call appears. */
export type ToolArgs = Record<string, unknown>;

// --- Messages ---------------------------------------------------------------

export type MessagePart =
  | {
      type: 'text';
      content: string;
    }
  | {
      type: 'tool_call';
      id: string;
      name: string;
      args: ToolArgs;
    }
  | {
      type: 'tool_call_response';
      id: string;
      response: string;
      status: ToolResultState;
    };

export type Message = {
  role: MessageRole;
  parts: MessagePart[];
  finishReason?: string;
};

// --- Span payloads ----------------------------------------------------------
// Each span kind splits its fields two ways: the Start subset (knowable when
// the span opens) and the End subset (knowable only once the work is done).
// End is the source of truth; Start is derived from it, so the two always
// partition the full payload.
//
// NOTE: kind payloads must never reuse a field name from SpanPayloadBase —
// a collision makes that union member uninhabited and TS reports the error
// on `kind`, not on the colliding field.

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
  promptName: string;
  promptVersion: string;
  promptHash: string;
  providerName: string;
  model: string;
  topK: number;
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

export type TurnOutcome = {
  type: 'reply';
  message: string;
};

export type TurnPayload = {
  customerInput: string;
  outcome?: TurnOutcome;
};

export type EndTurnPayload = Pick<TurnPayload, 'outcome'>;

export type StartTurnPayload = Omit<TurnPayload, keyof EndTurnPayload>;

export type SpanKindPayload =
  | ({ kind: 'model_call' } & ModelCallPayload)
  | ({ kind: 'tool_execution' } & ToolExecutionPayload)
  | ({ kind: 'turn' } & TurnPayload);

export type SpanTypes = SpanKindPayload['kind'];

/** The exported span shape — the contract eval assertions depend on. */
export type SpanPayload = SpanPayloadBase & SpanKindPayload;

/** A span as recorded in a CompletedTrace: swept, so duration is always stamped. */
export type CompletedSpanPayload = SpanPayload & { duration: number };

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
  backendKind: string;
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
