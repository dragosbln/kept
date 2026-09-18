// The HTTP surface, separated from boot so it can be exercised with Hono's
// request helper. Routes validate input and translate results to status
// codes; nothing here knows how a refund is decided or executed.
//
// /chat is the widget's endpoint and is open: the storefront calls it.
// /inbox and /inbox/* are the approval inbox, behind HTTP basic auth with
// one shared credential from env. The actor stamped on every action is the
// authenticated username: whoever holds the password is the actor, and the
// request carries no identity of its own. Per-user accounts and roles are a
// later change behind the same routes. A refused action is 409 with the
// refusal in the body, so a double click gets an answer, not an error page.

import { Hono } from 'hono';
import { basicAuth } from 'hono/basic-auth';
import { cors } from 'hono/cors';
import { DEFAULT_TOOL_TIMEOUT_MS } from '@kept-hq/core';
import type { ActionRefusal } from '@kept-hq/core';
import type { AgentService } from './handler.js';
import { renderInboxPage } from './inbox-page.js';

export type AppOptions = {
  /** Comma-separated origins the widget may POST from; `*` for any. */
  allowedOrigins: string[];
  /** The one credential the inbox accepts; its username is the actor on every action. */
  inbox: { user: string; password: string };
};

function statusFor(refusal: ActionRefusal): 404 | 409 {
  return refusal.reason === 'record_not_found' || refusal.reason === 'conversation_not_found'
    ? 404
    : 409;
}

/** The reconciliation window: the query when given and sane, the executor's tool timeout otherwise. */
const windowOf = (query: string | undefined): number => {
  const parsed = Number(query);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_TOOL_TIMEOUT_MS;
};

export function createApp(service: AgentService, options: AppOptions): Hono {
  const app = new Hono();

  app.use(
    '/chat',
    cors({
      origin: options.allowedOrigins.includes('*') ? '*' : options.allowedOrigins,
      allowMethods: ['POST', 'OPTIONS'],
      allowHeaders: ['content-type'],
    }),
  );

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

  // --- Inbox ----------------------------------------------------------------

  // One credential guards the page and the API alike. The middleware
  // compares in constant time; the browser's own prompt covers the page and,
  // the API being same-origin, every fetch the page makes afterwards.
  const inboxAuth = basicAuth({
    username: options.inbox.user,
    password: options.inbox.password,
    realm: 'Kept inbox',
  });
  app.use('/inbox', inboxAuth);
  app.use('/inbox/*', inboxAuth);
  const actor = options.inbox.user;

  app.get('/inbox', (c) => c.html(renderInboxPage({ actor })));

  app.get('/inbox/refunds/pending', async (c) =>
    c.json({ items: await service.inbox.listPending() }),
  );

  app.get('/inbox/refunds/needing-reconciliation', async (c) =>
    c.json({
      items: await service.inbox.listNeedingReconciliation(windowOf(c.req.query('windowMs'))),
    }),
  );

  app.get('/inbox/refunds/:id', async (c) => {
    const detail = await service.inbox.getRefund(c.req.param('id'));
    return detail ? c.json(detail) : c.json({ error: 'record not found' }, 404);
  });

  app.get('/inbox/audit', async (c) => {
    const conversationId = c.req.query('conversationId');
    const recordId = c.req.query('recordId');
    const entries = await service.inbox.listAudit({
      ...(conversationId ? { conversationId } : {}),
      ...(recordId ? { recordId } : {}),
    });
    return c.json({ entries });
  });

  app.post('/inbox/refunds/:id/approve', async (c) => {
    const result = await service.inbox.approve(c.req.param('id'), actor);
    return result.status === 'done' ? c.json(result) : c.json(result, statusFor(result));
  });

  app.post('/inbox/refunds/:id/deny', async (c) => {
    const result = await service.inbox.deny(c.req.param('id'), actor);
    return result.status === 'done' ? c.json(result) : c.json(result, statusFor(result));
  });

  app.post('/inbox/refunds/:id/reconcile', async (c) => {
    const result = await service.inbox.reconcile(
      c.req.param('id'),
      actor,
      windowOf(c.req.query('windowMs')),
    );
    return result.status === 'done' ? c.json(result) : c.json(result, statusFor(result));
  });

  app.post('/inbox/conversations/:id/take-over', async (c) => {
    const result = await service.inbox.takeOver(c.req.param('id'), actor);
    return result.status === 'done' ? c.json(result) : c.json(result, statusFor(result));
  });

  return app;
}
