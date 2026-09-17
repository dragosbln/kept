// Agent service — process bootstrap. Thin by design: env is read here and
// nowhere deeper, the service is built once at boot, the routes live in
// app.ts so they can be tested without a socket.

import { serve } from '@hono/node-server';
import { createApp } from './app.js';
import { configFromEnv, createAgentService } from './handler.js';

const PORT = Number(process.env['PORT'] ?? 3100);

const service = await createAgentService(configFromEnv(process.env));

// The widget POSTs from the storefront's origin. Comma-separated allowlist;
// `*` (the default) is right for local development and for a widget that
// any merchant page may embed — tighten it per deployment.
const allowedOrigins = (process.env['KEPT_ALLOWED_ORIGINS'] ?? '*')
  .split(',')
  .map((origin) => origin.trim())
  .filter((origin) => origin.length > 0);

const app = createApp(service, { allowedOrigins });

const server = serve({ fetch: app.fetch, port: PORT }, (info) => {
  console.log(`agent service listening on http://localhost:${info.port}`);
  console.log(`approval inbox at http://localhost:${info.port}/inbox`);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    server.close(() => {
      // Drain pending trace exports before the process dies.
      void service.shutdown().finally(() => process.exit(0));
    });
  });
}
