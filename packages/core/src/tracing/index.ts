// Public surface of the trace layer. The recorder (Trace + span handles) and
// the completed-trace types are the interface everything else builds on: the
// agent loop records through Trace, eval assertions read CompletedTrace
// (ADR 0001), and the exporter maps it to OTLP for Langfuse.

export { Trace } from './trace.js';
export { SpanBase, ModelCallSpan, ToolExecutionSpan, TurnSpan } from './span.js';
export type {
  CompletedSpanPayload,
  CompletedTrace,
  EndModelCallPayload,
  EndToolExecutionPayload,
  ErrorType,
  Message,
  MessagePart,
  MessageRole,
  ModelCallPayload,
  ModelCallSpanPayload,
  SpanKindPayload,
  SpanPayload,
  SpanPayloadBase,
  SpanStatus,
  SpanTypes,
  StartModelCallPayload,
  StartToolExecutionPayload,
  StartTurnPayload,
  ToolArgs,
  ToolExecutionPayload,
  ToolExecutionSpanPayload,
  EndTurnPayload,
  ToolResultState,
  TraceConfig,
  TracePayload,
  TurnPayload,
  TurnSpanPayload,
} from './types.js';
export type { TraceExporter } from './export/exporter.js';
export { LangfuseExporter, mapTraceToOTLPEnvelope } from './export/langfuse.js';
export { langfuseAttributes, otelAttributes, semConvCommitSha } from './export/otel-attributes.js';
