import type {
  CompletedTrace,
  Message,
  SpanPayload,
  SpanTypes,
  ToolArgs,
  TurnSpanPayload,
} from '../types.js';
import type { TraceExporter } from './exporter.js';
import { langfuseAttributes, otelAttributes } from './otel-attributes.js';

function mapOperationName(spanKind: SpanTypes) {
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

function millisecondsToNanoStr(input: number) {
  return (BigInt(Math.round(input)) * BigInt(1e6)).toString();
}

type OTLPStatus = {
  code: 0 | 1 | 2;
  message?: string | undefined;
};

function getOLTPStatus(span: SpanPayload): OTLPStatus {
  switch (span.status) {
    case 'completed':
      return {
        code: 1,
      };
    case 'error':
      return {
        code: 2,
        message: span.errorType,
      };
    case 'undetermined':
      return {
        code: 2,
        message: 'undetermined',
      };
    case 'in_progress':
      return {
        code: 0,
        message: 'in_progress',
      };
  }
}

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

function toOtlpSpanId(id: string) {
  return id.replaceAll('-', '').slice(0, 16);
}

export function dropUndefinedAttributes(attributes: OtlpAttribute[]): OtlpAttribute[] {
  return attributes.filter(
    ({ value }) =>
      value !== undefined && Object.values(value).some((scalar) => scalar !== undefined),
  );
}

type OtlpMessagePart =
  | { type: 'text'; content: string }
  | { type: 'tool_call'; id: string; name: string; arguments: ToolArgs }
  | { type: 'tool_call_response'; id: string; response: string };

function toOtlpMessages(messages: Message[]) {
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

function getTurnOutputMessage(span: TurnSpanPayload) {
  if (span.outcome?.type === 'reply') {
    return span.outcome.message;
  }
  return undefined;
}

function mapSpanAttributes(trace: CompletedTrace, span: SpanPayload) {
  const attributes = [
    { key: langfuseAttributes.sessionId, value: { stringValue: trace.sessionId } },
    {
      key: langfuseAttributes.faultToggles,
      value: { stringValue: JSON.stringify(trace.faultToggles) },
    },
    { key: langfuseAttributes.backendKind, value: { stringValue: trace.backendKind } },
    { key: langfuseAttributes.promptHash, value: { stringValue: trace.promptHash } },
    { key: otelAttributes.sessionId, value: { stringValue: trace.sessionId } },
    { key: otelAttributes.errorType, value: { stringValue: span.errorType } },
  ];

  const operationName = mapOperationName(span.kind);
  if (operationName) {
    attributes.push({ key: otelAttributes.operationName, value: { stringValue: operationName } });
  }

  switch (span.kind) {
    case 'turn':
      return [
        ...attributes,
        {
          key: langfuseAttributes.input,
          value: { stringValue: span.customerInput },
        },
        {
          key: langfuseAttributes.output,
          value: {
            stringValue: getTurnOutputMessage(span),
          },
        },
        { key: langfuseAttributes.outcomeType, value: { stringValue: span.outcome?.type } },
      ];
    case 'model_call':
      return [
        ...attributes,
        { key: otelAttributes.model, value: { stringValue: span.model } },
        { key: otelAttributes.providerName, value: { stringValue: span.providerName } },
        { key: otelAttributes.temperature, value: { doubleValue: span.temperature } },
        { key: otelAttributes.topK, value: { intValue: span.topK } },
        { key: otelAttributes.inputTokens, value: { intValue: span.inputTokens } },
        { key: otelAttributes.outputTokens, value: { intValue: span.outputTokens } },
        {
          key: langfuseAttributes.input,
          value: { stringValue: JSON.stringify(toOtlpMessages(span.inputMessages)) },
        },
        {
          key: langfuseAttributes.output,
          value: {
            stringValue: span.outputMessages
              ? JSON.stringify(toOtlpMessages(span.outputMessages))
              : undefined,
          },
        },
        {
          key: otelAttributes.inputMessages,
          value: { stringValue: JSON.stringify(toOtlpMessages(span.inputMessages)) },
        },
        {
          key: otelAttributes.outputMessages,
          value: {
            stringValue: span.outputMessages
              ? JSON.stringify(toOtlpMessages(span.outputMessages))
              : undefined,
          },
        },
        { key: langfuseAttributes.promptName, value: { stringValue: span.promptName } },
        { key: otelAttributes.promptName, value: { stringValue: span.promptName } },
        { key: langfuseAttributes.promptVersion, value: { stringValue: span.promptVersion } },
        { key: otelAttributes.promptVersion, value: { stringValue: span.promptVersion } },
      ];
    case 'tool_execution':
      return [
        ...attributes,
        { key: otelAttributes.toolName, value: { stringValue: span.toolName } },
        { key: otelAttributes.toolCallId, value: { stringValue: span.callId } },
        { key: otelAttributes.toolArguments, value: { stringValue: JSON.stringify(span.args) } },
        {
          key: langfuseAttributes.input,
          value: { stringValue: JSON.stringify(span.args) },
        },
        { key: otelAttributes.toolResult, value: { stringValue: JSON.stringify(span.result) } },
        {
          key: langfuseAttributes.output,
          value: { stringValue: JSON.stringify(span.result) },
        },
        { key: langfuseAttributes.resultState, value: { stringValue: span.resultState } },
      ];
    default:
      return attributes;
  }
}

export function mapTraceToOTLPEnvelope(input: CompletedTrace) {
  const spans = input.spans.map((span) => ({
    traceId: input.id.replaceAll('-', ''),
    spanId: toOtlpSpanId(span.id),
    ...(span.parentId ? { parentSpanId: toOtlpSpanId(span.parentId) } : {}),
    name: span.kind,
    startTimeUnixNano: millisecondsToNanoStr(span.startedAt),
    endTimeUnixNano: millisecondsToNanoStr(span.startedAt + span.duration),
    status: getOLTPStatus(span),
    attributes: dropUndefinedAttributes(mapSpanAttributes(input, span)),
  }));

  return {
    resourceSpans: [
      {
        resource: {
          attributes: [
            {
              key: 'service.name',
              value: { stringValue: 'kept-agent' },
            },
          ],
        },
        scopeSpans: [{ scope: { name: 'kept-tracing' }, spans }],
      },
    ],
  };
}

type LangfuseExporterConfig = {
  baseUrl: string;
  publicKey: string;
  secretKey: string;
};

export class LangfuseExporter implements TraceExporter {
  private readonly baseUrl: string;
  private readonly publicKey: string;
  private readonly secretKey: string;

  private pending: Set<Promise<void>> = new Set();

  constructor({ baseUrl, publicKey, secretKey }: LangfuseExporterConfig) {
    this.baseUrl = baseUrl;
    this.publicKey = publicKey;
    this.secretKey = secretKey;
  }

  export(input: CompletedTrace): void {
    try {
      const exported = mapTraceToOTLPEnvelope(input);
      const promise = fetch(`${this.baseUrl}/api/public/otel/v1/traces`, {
        headers: {
          'Content-Type': 'application/json',
          Authorization:
            'Basic ' + Buffer.from(`${this.publicKey}:${this.secretKey}`).toString('base64'),
        },
        signal: AbortSignal.timeout(10_000),
        method: 'POST',
        body: JSON.stringify(exported),
      })
        .then(async (res) => {
          if (!res.ok) {
            const text = await res.text();
            console.warn('langfuse export: Failed response', {
              status: res.status,
              textSnippet: `${text.slice(0, 200)}...`,
            });
          }
        })
        .catch((error) => {
          console.error('langfuse export: Network failure', error);
        });
      this.pending.add(promise);
      promise.finally(() => this.pending.delete(promise));
    } catch (error) {
      console.error('langfuse export: ', error);
    }
  }

  async flush(): Promise<void> {
    await Promise.allSettled(this.pending);
  }
}
