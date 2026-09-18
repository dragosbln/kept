// Agent service — process bootstrap. Thin by design: env is read here and
// nowhere deeper, the service is built once at boot, the routes live in
// app.ts so they can be tested without a socket.

import { serve } from '@hono/node-server';
import { createApp } from './app.js';
import { configFromEnv, createAgentService } from './handler.js';

const PORT = Number(process.env['PORT'] ?? 3100);

// The inbox approves refunds, so it is guarded from the first boot: one
// shared credential, required, read here the way the model key is. The
// username is the actor on every inbox action.
const inboxUser = process.env['KEPT_INBOX_USER'];
const inboxPassword = process.env['KEPT_INBOX_PASSWORD'];
if (!inboxUser || !inboxPassword) {
  throw new Error(
    'KEPT_INBOX_USER and KEPT_INBOX_PASSWORD are not set — the approval inbox needs a credential before the service will start',
  );
}

const config = configFromEnv(process.env);
const service = await createAgentService(config);

// The widget POSTs from the storefront's origin. Comma-separated allowlist;
// `*` (the default) is right for local development and for a widget that
// any merchant page may embed — tighten it per deployment.
const allowedOrigins = (process.env['KEPT_ALLOWED_ORIGINS'] ?? '*')
  .split(',')
  .map((origin) => origin.trim())
  .filter((origin) => origin.length > 0);

const app = createApp(service, {
  allowedOrigins,
  inbox: { user: inboxUser, password: inboxPassword },
});

const server = serve({ fetch: app.fetch, port: PORT }, (info) => {
  console.log(`agent service listening on http://localhost:${info.port}`);
  console.log(`model: ${config.provider} · ${config.model} · prompt ${config.promptVersion}`);
  console.log(`approval inbox at http://localhost:${info.port}/inbox (user: ${inboxUser})`);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    server.close(() => {
      // Drain pending trace exports before the process dies.
      void service.shutdown().finally(() => process.exit(0));
    });
  });
}
