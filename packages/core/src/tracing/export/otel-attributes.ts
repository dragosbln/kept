// Attribute vocabulary for the export path.
//
// `otelAttributes` holds OTel GenAI semantic-convention names. The GenAI
// conventions are still moving (no stable release to pin a version against),
// so `semConvCommitSha` records the exact semantic-conventions commit these
// names were copied from.
//
// `langfuseAttributes` holds Langfuse's product-specific names. The exporter
// dual-emits both vocabularies: gen_ai.* keeps traces portable to any OTLP
// consumer, langfuse.* drives rendering (input/output panes, session
// grouping, metadata).

export const semConvCommitSha = '8c1b98a376e91d422726ccf33bef051fd9ce4b25';

export const otelAttributes = {
  operationName: 'gen_ai.operation.name',
  providerName: 'gen_ai.provider.name',
  errorType: 'error.type',
  sessionId: 'gen_ai.conversation.id',
  promptName: 'gen_ai.prompt.name',
  promptVersion: 'gen_ai.prompt.version',
  model: 'gen_ai.request.model',
  topK: 'gen_ai.request.top_k',
  temperature: 'gen_ai.request.temperature',
  inputTokens: 'gen_ai.usage.input_tokens',
  outputTokens: 'gen_ai.usage.output_tokens',
  inputMessages: 'gen_ai.input.messages',
  outputMessages: 'gen_ai.output.messages',
  toolName: 'gen_ai.tool.name',
  toolArguments: 'gen_ai.tool.call.arguments',
  toolResult: 'gen_ai.tool.call.result',
  toolCallId: 'gen_ai.tool.call.id',
} as const;

export const langfuseAttributes = {
  input: 'langfuse.observation.input',
  output: 'langfuse.observation.output',
  sessionId: 'langfuse.session.id',
  promptName: 'langfuse.observation.prompt.name',
  promptVersion: 'langfuse.observation.prompt.version',
  promptHash: 'langfuse.trace.metadata.promptHash',
  resultState: 'langfuse.observation.metadata.resultState',
  faultToggles: 'langfuse.trace.metadata.faultToggles',
  backendKind: 'langfuse.trace.metadata.backendKind',
  outcomeType: 'langfuse.observation.metadata.outcomeType',
  outcomeReason: 'langfuse.observation.metadata.outcomeReason',
} as const;
