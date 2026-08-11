// Agent service — process bootstrap only.
//
// Scaffolding: server wiring, health, graceful shutdown. The conversation
// route lands here once the hand-written trace layer and agent loop exist in
// @kept-hq/core; this file should stay thin enough to read in one screen.

import { serve } from '@hono/node-server';
import { Hono } from 'hono';

const PORT = Number(process.env['PORT'] ?? 3100);

const app = new Hono();

app.get('/health', (c) => c.json({ status: 'ok', service: 'agent' }));

const server = serve({ fetch: app.fetch, port: PORT }, (info) => {
  console.log(`agent service listening on http://localhost:${info.port}`);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
  });
}
