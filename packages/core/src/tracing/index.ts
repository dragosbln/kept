// Public surface of the trace layer. The recorder (Trace + span handles) and
// the completed-trace types are the interface everything else builds on: the
// agent loop records through Trace, eval assertions read CompletedTrace
// (ADR 0001), and the exporter maps it to OTLP for Langfuse.
//
// Span classes are exported as types only: Trace is the sole factory, so a
// span can never exist outside a trace's span list and its end-of-trace
// sweep.

export { Trace } from './trace.js';
export type { AnySpan, ModelCallSpan, SpanBase, ToolExecutionSpan, TurnSpan } from './span.js';
export type {
  BackendKind,
  CompletedSpanPayload,
  CompletedTrace,
  EndModelCallPayload,
  EndToolExecutionPayload,
  EndTurnPayload,
  ErrorType,
  Message,
  MessagePart,
  MessageRole,
  ModelCallPayload,
  ModelCallSpanPayload,
  SettledSpanStatus,
  SpanKind,
  SpanKindPayload,
  SpanPayload,
  SpanPayloadBase,
  SpanStatus,
  StartModelCallPayload,
  StartToolExecutionPayload,
  StartTurnPayload,
  ToolArgs,
  ToolExecutionPayload,
  ToolExecutionSpanPayload,
  ToolResultState,
  TraceConfig,
  TracePayload,
  TurnPayload,
  TurnSpanPayload,
  WellKnownErrorType,
} from './types.js';
export type { TraceExporter } from './export/exporter.js';
export { LangfuseExporter } from './export/langfuse.js';
export type { ExportErrorEvent, LangfuseExporterConfig } from './export/langfuse.js';
export { mapTraceToOTLPEnvelope } from './export/otlp.js';
export type { OtlpAttribute, OtlpEnvelope, OtlpSpan } from './export/otlp.js';
export { langfuseAttributes, otelAttributes, semConvCommitSha } from './export/otel-attributes.js';
