// Route tests through Hono's request helper: the inbox reads and actions
// over a service built with injected in-memory deps, and the take-over
// rule on /chat. The model client is constructed but never called: every
// path here either reads the ledger or is a handed-off conversation.

import { describe, expect, it } from 'vitest';
import {
  DemoBackend,
  InMemoryAuditLog,
  InMemoryConversationStore,
  InMemoryRefundLedger,
  customerKeyFor,
  makeDemoOrders,
} from '@kept-hq/core';
import type { DecisionResult, RefundLedgerRecord } from '@kept-hq/core';
import { createApp } from './app.js';
import { HANDOFF_REPLY, createAgentService, type AgentServiceConfig } from './handler.js';

const config: AgentServiceConfig = {
  provider: 'anthropic',
  model: 'fake-model',
  maxTokens: 64,
  promptVersion: '1.1.0',
  backendKind: 'demo',
  apiKey: 'test-key-never-used',
};

type World = {
  app: ReturnType<typeof createApp>;
  ledger: InMemoryRefundLedger;
  store: InMemoryConversationStore;
  conversationId: string;
};

async function setup(): Promise<World> {
  const ledger = new InMemoryRefundLedger();
  const store = new InMemoryConversationStore();
  const conversation = await store.createNewConversation();
  await store.updateConversationHistory(conversation.id, [
    { role: 'user', parts: [{ type: 'text', content: 'Refund the jacket.' }] },
  ]);
  const service = await createAgentService(config, {
    backend: new DemoBackend(makeDemoOrders()),
    ledger,
    store,
    auditLog: new InMemoryAuditLog(),
  });
  return {
    app: createApp(service, { allowedOrigins: ['*'] }),
    ledger,
    store,
    conversationId: conversation.id,
  };
}

async function pendingRecord(world: World): Promise<RefundLedgerRecord> {
  const customerKey = customerKeyFor({ email: 'ana@example.com' });
  const decision: DecisionResult = {
    outcome: 'require_approval',
    reason: 'cap_exceeded',
    record: {
      configHash: 'cfg-1',
      request: {
        action: 'issue_refund',
        customerKey,
        orderId: 'order-1004',
        orderItemId: 'order-1004-line-1',
        quantity: 1,
        currency: 'EUR',
        amountMinorUnits: 15_900,
      },
      eligibility: [],
      perCap: [],
    },
  };
  const result = await world.ledger.recordRefund(
    {
      callId: 'call-1',
      orderId: 'order-1004',
      orderItemId: 'order-1004-line-1',
      quantity: 1,
      customerKey,
      conversationId: world.conversationId,
      promptHash: 'hash-1',
      amountMinorUnits: 15_900,
      currency: 'EUR',
    },
    [],
    () => decision,
  );
  if (result.outcome === 'deny') throw new Error('test bug');
  return result.ledgerRecord;
}

const json = async (res: Response): Promise<Record<string, unknown>> =>
  (await res.json()) as Record<string, unknown>;

describe('inbox routes', () => {
  it('serves the page and lists the pending record with its conversation', async () => {
    const world = await setup();
    const record = await pendingRecord(world);

    const page = await world.app.request('/inbox');
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('Approval inbox');

    const list = await json(await world.app.request('/inbox/refunds/pending'));
    expect(list['items']).toHaveLength(1);
    expect((list['items'] as { record: { id: string } }[])[0]!.record.id).toBe(record.id);

    const detail = await world.app.request(`/inbox/refunds/${record.id}`);
    expect(detail.status).toBe(200);
    expect(await json(detail)).toMatchObject({
      record: { id: record.id, status: 'pending' },
      conversation: { id: world.conversationId },
      auditEntries: [],
    });
    expect((await world.app.request('/inbox/refunds/nope')).status).toBe(404);
  });

  it('approve executes the refund with the actor from the header; a second approve is 409', async () => {
    const world = await setup();
    const record = await pendingRecord(world);
    const headers = { 'x-kept-actor': 'dragos' };

    const first = await world.app.request(`/inbox/refunds/${record.id}/approve`, {
      method: 'POST',
      headers,
    });
    expect(first.status).toBe(200);
    expect(await json(first)).toMatchObject({
      status: 'done',
      record: { status: 'ok' },
      audit: { actor: 'dragos', action: 'approve', statusAfter: 'ok' },
    });

    const again = await world.app.request(`/inbox/refunds/${record.id}/approve`, {
      method: 'POST',
      headers,
    });
    expect(again.status).toBe(409);
    expect(await json(again)).toMatchObject({ status: 'refused', reason: 'illegal_transition' });

    const audit = await json(await world.app.request('/inbox/audit'));
    expect(audit['entries']).toHaveLength(1);
    expect((await world.app.request('/inbox/refunds/nope/deny', { method: 'POST' })).status).toBe(
      404,
    );
  });

  it('deny closes the record without executing it', async () => {
    const world = await setup();
    const record = await pendingRecord(world);

    const res = await world.app.request(`/inbox/refunds/${record.id}/deny`, { method: 'POST' });

    expect(res.status).toBe(200);
    expect(await json(res)).toMatchObject({
      status: 'done',
      record: { status: 'denied' },
      audit: { actor: 'human' },
    });
  });

  it('a taken-over conversation gets the deferral on /chat and the model is never asked', async () => {
    const world = await setup();

    const takeOver = await world.app.request(
      `/inbox/conversations/${world.conversationId}/take-over`,
      {
        method: 'POST',
        headers: { 'x-kept-actor': 'dragos' },
      },
    );
    expect(takeOver.status).toBe(200);
    expect(
      (
        await world.app.request(`/inbox/conversations/${world.conversationId}/take-over`, {
          method: 'POST',
        })
      ).status,
    ).toBe(409);

    const chat = await world.app.request('/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        message: 'Any news on my refund?',
        conversationId: world.conversationId,
      }),
    });
    expect(chat.status).toBe(200);
    expect(await json(chat)).toMatchObject({ outcome: { type: 'reply', message: HANDOFF_REPLY } });
    const conversation = await world.store.findConversation(world.conversationId);
    expect(conversation?.messages.map((m) => m.role)).toEqual(['user', 'user', 'assistant']);
  });
});
