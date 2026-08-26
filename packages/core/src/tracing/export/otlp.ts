// Maps a CompletedTrace to an OTLP/JSON ExportTraceServiceRequest envelope.
// Attribute names come from the pinned vocabulary in otel-attributes.ts;
// every span dual-emits the portable gen_ai.* attributes and the langfuse.*
// attributes that drive rendering (input/output panes, session grouping).

import type { Message, MessageRole, ToolArgs } from '../../messages.js';
import type { CompletedSpanPayload, CompletedTrace, SpanKind, TurnSpanPayload } from '../types.js';
import { langfuseAttributes, otelAttributes } from './otel-attributes.js';

const SERVICE_NAME = 'kept-agent';
const INSTRUMENTATION_SCOPE = 'kept-tracing';

/** Status codes from the OTLP trace proto (Status.StatusCode). */
const OTLP_STATUS_CODE = {
  unset: 0,
  ok: 1,
  error: 2,
} as const;

type OtlpStatus = {
  code: (typeof OTLP_STATUS_CODE)[keyof typeof OTLP_STATUS_CODE];
  message?: string | undefined;
};

type OtlpAttributeValue = {
  stringValue?: string | undefined;
  intValue?: number | undefined;
  doubleValue?: number | undefined;
  boolValue?: boolean | undefined;
};

export type OtlpAttribute = {
  key: string;
  value: OtlpAttributeValue;
};

// Attribute constructors. Values may be undefined; dropUndefinedAttributes
// strips those entries before the envelope is built.
const str = (key: string, value: string | undefined): OtlpAttribute => ({
  key,
  value: { stringValue: value },
});
const int = (key: string, value: number | undefined): OtlpAttribute => ({
  key,
  value: { intValue: value },
});
const double = (key: string, value: number | undefined): OtlpAttribute => ({
  key,
  value: { doubleValue: value },
});

function dropUndefinedAttributes(attributes: OtlpAttribute[]): OtlpAttribute[] {
  return attributes.filter(
    ({ value }) =>
      value !== undefined && Object.values(value).some((scalar) => scalar !== undefined),
  );
}

function mapOperationName(spanKind: SpanKind): 'chat' | 'execute_tool' | null {
  switch (spanKind) {
    case 'model_call':
      return 'chat';
    case 'tool_execution':
      return 'execute_tool';
    case 'turn':
      return null;
    default:
      spanKind satisfies never;
      return null;
  }
}

function millisecondsToNanoStr(input: number): string {
  return (BigInt(Math.round(input)) * BigInt(1e6)).toString();
}

function getOtlpStatus(span: CompletedSpanPayload): OtlpStatus {
  switch (span.status) {
    case 'completed':
      return { code: OTLP_STATUS_CODE.ok };
    case 'error':
      return { code: OTLP_STATUS_CODE.error, message: span.errorType };
    case 'undetermined':
      // Deliberately ERROR rather than UNSET: a span the sweep had to close
      // is a lifecycle bug in the caller and should be loud in the UI.
      return { code: OTLP_STATUS_CODE.error, message: 'undetermined' };
  }
}

/** OTel ids are dash-less hex: 128-bit trace ids, 64-bit span ids (UUID, truncated). */
function toOtlpSpanId(id: string): string {
  return id.replaceAll('-', '').slice(0, 16);
}

type OtlpMessagePart =
  | { type: 'text'; content: string }
  | { type: 'tool_call'; id: string; name: string; arguments: ToolArgs }
  | { type: 'tool_call_response'; id: string; response: string };

type OtlpMessage = {
  role: MessageRole;
  finish_reason: string | undefined;
  parts: OtlpMessagePart[];
};

function toOtlpMessages(messages: Message[]): OtlpMessage[] {
  return messages.map((message) => ({
    role: message.role,
    finish_reason: message.finishReason,
    parts: message.parts.flatMap((part): OtlpMessagePart[] => {
      switch (part.type) {
        case 'text':
          return [
            {
              type: part.type,
              content: part.content,
            },
          ];
        case 'tool_call':
          return [
            {
              type: part.type,
              id: part.id,
              name: part.name,
              arguments: part.args,
            },
          ];
        case 'tool_call_response':
          // The part-level result `status` is dropped in translation: the
          // convention shape has no slot for it, and the authoritative
          // resultState lives on the tool_execution span.
          return [
            {
              type: part.type,
              id: part.id,
              response: part.response,
            },
          ];
        default:
          part satisfies never;
          return [];
      }
    }),
  }));
}

function getTurnOutputMessage(span: TurnSpanPayload): string | undefined {
  if (!span.outcome) {
    return undefined;
  }
  if (span.outcome.type === 'reply') {
    return span.outcome.message;
  } else {
    return '';
  }
}

function getTurnOutputReason(span: TurnSpanPayload): string | undefined {
  if (span.outcome?.type === 'failed') {
    return span.outcome.reason;
  }

  return undefined;
}

function mapSpanAttributes(trace: CompletedTrace, span: CompletedSpanPayload): OtlpAttribute[] {
  const attributes = [
    str(langfuseAttributes.sessionId, trace.sessionId),
    str(langfuseAttributes.faultToggles, JSON.stringify(trace.faultToggles)),
    str(langfuseAttributes.backendKind, trace.backendKind),
    str(langfuseAttributes.promptHash, trace.promptHash),
    str(otelAttributes.sessionId, trace.sessionId),
    str(otelAttributes.errorType, span.errorType),
  ];

  const operationName = mapOperationName(span.kind);
  if (operationName) {
    attributes.push(str(otelAttributes.operationName, operationName));
  }

  switch (span.kind) {
    case 'turn':
      return [
        ...attributes,
        str(langfuseAttributes.input, span.customerInput),
        str(langfuseAttributes.output, getTurnOutputMessage(span)),
        str(langfuseAttributes.outcomeType, span.outcome?.type),
        str(langfuseAttributes.outcomeReason, getTurnOutputReason(span)),
      ];
    case 'model_call': {
      const inputMessages = JSON.stringify(toOtlpMessages(span.inputMessages));
      const outputMessages = span.outputMessages
        ? JSON.stringify(toOtlpMessages(span.outputMessages))
        : undefined;
      return [
        ...attributes,
        str(otelAttributes.model, span.model),
        str(otelAttributes.providerName, span.providerName),
        double(otelAttributes.temperature, span.temperature),
        int(otelAttributes.inputTokens, span.inputTokens),
        int(otelAttributes.outputTokens, span.outputTokens),
        str(langfuseAttributes.input, inputMessages),
        str(langfuseAttributes.output, outputMessages),
        str(otelAttributes.inputMessages, inputMessages),
        str(otelAttributes.outputMessages, outputMessages),
        str(langfuseAttributes.promptName, span.promptName),
        str(otelAttributes.promptName, span.promptName),
        str(langfuseAttributes.promptVersion, span.promptVersion),
        str(otelAttributes.promptVersion, span.promptVersion),
      ];
    }
    case 'tool_execution': {
      const args = JSON.stringify(span.args);
      const result = JSON.stringify(span.result);
      return [
        ...attributes,
        str(otelAttributes.toolName, span.toolName),
        str(otelAttributes.toolCallId, span.callId),
        str(otelAttributes.toolArguments, args),
        str(langfuseAttributes.input, args),
        str(otelAttributes.toolResult, result),
        str(langfuseAttributes.output, result),
        str(langfuseAttributes.resultState, span.resultState),
      ];
    }
    default:
      span satisfies never;
      return attributes;
  }
}

export type OtlpSpan = {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: SpanKind;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  status: OtlpStatus;
  attributes: OtlpAttribute[];
};

/** The OTLP/JSON ExportTraceServiceRequest shape the exporter POSTs. */
export type OtlpEnvelope = {
  resourceSpans: {
    resource: { attributes: OtlpAttribute[] };
    scopeSpans: { scope: { name: string }; spans: OtlpSpan[] }[];
  }[];
};

export function mapTraceToOTLPEnvelope(input: CompletedTrace): OtlpEnvelope {
  const spans = input.spans.map((span) => ({
    traceId: input.id.replaceAll('-', ''),
    spanId: toOtlpSpanId(span.id),
    ...(span.parentId ? { parentSpanId: toOtlpSpanId(span.parentId) } : {}),
    name: span.kind,
    startTimeUnixNano: millisecondsToNanoStr(span.startedAt),
    endTimeUnixNano: millisecondsToNanoStr(span.startedAt + span.duration),
    status: getOtlpStatus(span),
    attributes: dropUndefinedAttributes(mapSpanAttributes(input, span)),
  }));

  return {
    resourceSpans: [
      {
        resource: {
          attributes: [
            {
              key: 'service.name',
              value: { stringValue: SERVICE_NAME },
            },
          ],
        },
        scopeSpans: [{ scope: { name: INSTRUMENTATION_SCOPE }, spans }],
      },
    ],
  };
}
