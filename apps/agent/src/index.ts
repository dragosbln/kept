// Agent service — process bootstrap and HTTP surface. Thin by design: env is
// read here and nowhere deeper, the service is built once at boot, and the
// route only validates input and translates HandleMessageResult to HTTP.

import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { configFromEnv, createAgentService } from './handler.js';

const PORT = Number(process.env['PORT'] ?? 3100);

const service = await createAgentService(configFromEnv(process.env));

const app = new Hono();

app.get('/health', (c) => c.json({ status: 'ok', service: 'agent' }));

app.post('/chat', async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'body must be JSON' }, 400);
  }

  const { message, conversationId } = (body ?? {}) as {
    message?: unknown;
    conversationId?: unknown;
  };
  if (typeof message !== 'string' || message.trim().length === 0) {
    return c.json({ error: 'message must be a non-empty string' }, 400);
  }
  if (conversationId !== undefined && typeof conversationId !== 'string') {
    return c.json({ error: 'conversationId must be a string when present' }, 400);
  }

  const result = await service.handleNewMessage(message, conversationId);
  if (result.kind === 'conversation_not_found') {
    return c.json({ error: 'conversation not found' }, 404);
  }
  return c.json({ conversationId: result.conversationId, outcome: result.outcome });
});

const server = serve({ fetch: app.fetch, port: PORT }, (info) => {
  console.log(`agent service listening on http://localhost:${info.port}`);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    server.close(() => {
      // Drain pending trace exports before the process dies.
      void service.shutdown().finally(() => process.exit(0));
    });
  });
}
