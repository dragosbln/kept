// Fabricates one fake WISMO conversation as a trace and exports it to the
// local Langfuse (docker compose) so the OTLP mapping can be verified by eye.
// This is a dev tool, not a test: the one automated exporter check is the
// smoke test (see ADR 0001).
//
//   pnpm stack:up
//   pnpm demo:trace          # tsx --env-file-if-exists=.env scripts/trace-demo.ts

import { setTimeout as sleep } from 'node:timers/promises';
import { LangfuseExporter, Trace, type Message } from '../packages/core/src/tracing/index.ts';

const { LANGFUSE_URL, LANGFUSE_PUBLIC_KEY, LANGFUSE_SECRET_KEY } = process.env;
if (!LANGFUSE_URL || !LANGFUSE_PUBLIC_KEY || !LANGFUSE_SECRET_KEY) {
  console.error(
    'Missing LANGFUSE_URL / LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY.',
    'Run via `pnpm demo:trace` with a populated .env (cp .env.example .env).',
  );
  process.exit(1);
}

// --- One fake conversation ---------------------------------------------------

const promptStamp = {
  promptName: 'support-agent',
  promptVersion: 'demo-1',
  promptHash: 'deadbeefdemo',
};
const modelConfig = {
  ...promptStamp,
  providerName: 'anthropic',
  model: 'claude-sonnet-5',
};

const systemMessage: Message = {
  role: 'system',
  parts: [{ type: 'text', content: 'You are Kept, a post-purchase support agent.' }],
};
const userMessage: Message = {
  role: 'user',
  parts: [{ type: 'text', content: 'Where is my order #1042?' }],
};
const toolCallMessage: Message = {
  role: 'assistant',
  parts: [
    {
      type: 'tool_call',
      id: 'call_demo_1',
      name: 'lookup_order',
      args: { orderNumber: '1042', email: 'jane@example.com' },
    },
  ],
  finishReason: 'tool_use',
};
const orderResult = { orderNumber: '1042', status: 'shipped', carrier: 'DHL', eta: '2026-08-25' };
const toolResponseMessage: Message = {
  role: 'tool',
  parts: [
    {
      type: 'tool_call_response',
      id: 'call_demo_1',
      response: JSON.stringify(orderResult),
      status: 'ok',
    },
  ],
};

const trace = new Trace({
  ...promptStamp,
  sessionId: `demo-${Date.now()}`,
  providerName: 'anthropic',
  backendKind: 'demo',
});

const turn = trace.startTurnSpan(null, { customerInput: 'Where is my order #1042?' });

const firstCall = trace.startModelCallSpan(turn.id, {
  ...modelConfig,
  inputMessages: [systemMessage, userMessage],
});
await sleep(120);
firstCall.end({ inputTokens: 812, outputTokens: 64, outputMessages: [toolCallMessage] });

const toolSpan = trace.startToolExecutionSpan(turn.id, {
  callId: 'call_demo_1',
  toolName: 'lookup_order',
  args: { orderNumber: '1042', email: 'jane@example.com' },
});
await sleep(45);
toolSpan.end({ resultState: 'ok', result: orderResult });

const secondCall = trace.startModelCallSpan(turn.id, {
  ...modelConfig,
  inputMessages: [systemMessage, userMessage, toolCallMessage, toolResponseMessage],
});
await sleep(150);
secondCall.end({
  inputTokens: 933,
  outputTokens: 41,
  outputMessages: [
    {
      role: 'assistant',
      parts: [{ type: 'text', content: 'Your order #1042 shipped with DHL — ETA Aug 25.' }],
      finishReason: 'stop',
    },
  ],
});

// Deliberately never ended: the sweep in Trace.end() must surface this as an
// `undetermined` span, which should be visibly marked in the Langfuse UI.
trace.startToolExecutionSpan(turn.id, {
  callId: 'call_demo_2',
  toolName: 'get_order_status',
  args: { orderNumber: '1042' },
});

turn.end({
  outcome: { type: 'reply', message: 'Your order #1042 shipped with DHL — ETA Aug 25.' },
});
const completed = trace.end();

// --- Export ------------------------------------------------------------------

const exporter = new LangfuseExporter({
  baseUrl: LANGFUSE_URL,
  publicKey: LANGFUSE_PUBLIC_KEY,
  secretKey: LANGFUSE_SECRET_KEY,
});
exporter.export(completed);
await exporter.flush();

console.log(`exported trace ${completed.id} (${completed.spans.length} spans)`);
for (const span of completed.spans) {
  console.log(`  ${span.kind.padEnd(15)} ${span.status.padEnd(12)} ${span.duration.toFixed(1)}ms`);
}
console.log(`open ${LANGFUSE_URL} and look for session ${completed.sessionId}`);
console.log('expected: 2 generations + 1 tool span under a turn, 1 undetermined span,');
console.log('and promptHash/faultToggles/backendKind in the trace metadata.');
