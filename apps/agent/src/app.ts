// The HTTP surface, separated from boot so it can be exercised with Hono's
// request helper. Routes validate input and translate results to status
// codes; nothing here knows how a refund is decided or executed.
//
// /chat is the widget's endpoint. /inbox/* is the approval inbox: reads are
// GETs, actions are POSTs carrying the actor in the x-kept-actor header (a
// name; there is no auth in v0). A refused action is 409 with the refusal
// in the body, so a double click gets an answer, not an error page. The
// inbox page itself is served at /inbox.

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { DEFAULT_TOOL_TIMEOUT_MS } from '@kept-hq/core';
import type { ActionRefusal } from '@kept-hq/core';
import type { AgentService } from './handler.js';
import { INBOX_PAGE_HTML } from './inbox-page.js';

export type AppOptions = {
  /** Comma-separated origins the widget may POST from; `*` for any. */
  allowedOrigins: string[];
};

const DEFAULT_ACTOR = 'human';

function statusFor(refusal: ActionRefusal): 404 | 409 {
  return refusal.reason === 'record_not_found' || refusal.reason === 'conversation_not_found'
    ? 404
    : 409;
}

const actorOf = (header: string | undefined): string => header?.trim() || DEFAULT_ACTOR;

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

  app.get('/inbox', (c) => c.html(INBOX_PAGE_HTML));

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
    const result = await service.inbox.approve(
      c.req.param('id'),
      actorOf(c.req.header('x-kept-actor')),
    );
    return result.status === 'done' ? c.json(result) : c.json(result, statusFor(result));
  });

  app.post('/inbox/refunds/:id/deny', async (c) => {
    const result = await service.inbox.deny(
      c.req.param('id'),
      actorOf(c.req.header('x-kept-actor')),
    );
    return result.status === 'done' ? c.json(result) : c.json(result, statusFor(result));
  });

  app.post('/inbox/refunds/:id/reconcile', async (c) => {
    const result = await service.inbox.reconcile(
      c.req.param('id'),
      actorOf(c.req.header('x-kept-actor')),
      windowOf(c.req.query('windowMs')),
    );
    return result.status === 'done' ? c.json(result) : c.json(result, statusFor(result));
  });

  app.post('/inbox/conversations/:id/take-over', async (c) => {
    const result = await service.inbox.takeOver(
      c.req.param('id'),
      actorOf(c.req.header('x-kept-actor')),
    );
    return result.status === 'done' ? c.json(result) : c.json(result, statusFor(result));
  });

  return app;
}
