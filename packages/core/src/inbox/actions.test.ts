// The inbox state machine against real in-memory ports: approve executes
// through the shared write path and audits who did it; deny closes the
// record; a second click on either is refused by the transition table, not
// thrown; reconcile replays through the key; take over marks the
// conversation once. Every action that took effect leaves exactly one
// audit entry with the statuses it moved between.

import { describe, expect, it } from 'vitest';
import { DemoBackend } from '../backend/demo.js';
import { makeDemoOrders, DEMO_SEED_EPOCH } from '../backend/seed-orders.js';
import { InMemoryConversationStore } from '../conversation/in-memory-conversation-store.js';
import { customerKeyFor } from '../refund-ledger/customer-key.js';
import { InMemoryRefundLedger } from '../refund-ledger/in-memory-refund-ledger.js';
import type { RecordRefundParams, RefundLedgerRecord } from '../refund-ledger/types.js';
import type { DecisionResult } from '../policy/types.js';
import { InMemoryAuditLog } from './audit-log.js';
import { InboxService } from './actions.js';
import type { InboxActions } from './types.js';

const NOW = DEMO_SEED_EPOCH;
const WINDOW_MS = 10_000;

type World = {
  clock: { now: number };
  ledger: InMemoryRefundLedger;
  store: InMemoryConversationStore;
  audit: InMemoryAuditLog;
  inbox: InboxActions;
  conversationId: string;
};

async function setup(): Promise<World> {
  const clock = { now: NOW };
  const now = (): number => clock.now;
  const ledger = new InMemoryRefundLedger([], now);
  const store = new InMemoryConversationStore();
  const audit = new InMemoryAuditLog(now);
  const conversation = await store.createNewConversation();
  await store.updateConversationHistory(conversation.id, [
    { role: 'user', parts: [{ type: 'text', content: 'Refund the jacket please, it has a cut.' }] },
    { role: 'assistant', parts: [{ type: 'text', content: 'A person will review it.' }] },
  ]);
  const backend = new DemoBackend(makeDemoOrders(NOW));
  return {
    clock,
    ledger,
    store,
    audit,
    conversationId: conversation.id,
    inbox: new InboxService({ ledger, backend, store, audit, now }),
  };
}

/** order-1004 line 1: the jacket, 1 × €159.00, over the per-call cap. */
function params(world: World): RecordRefundParams {
  return {
    callId: 'call-1',
    orderId: 'order-1004',
    orderItemId: 'order-1004-line-1',
    quantity: 1,
    customerKey: customerKeyFor({ email: 'ana@example.com' }),
    conversationId: world.conversationId,
    promptHash: 'hash-1',
    amountMinorUnits: 15_900,
    currency: 'EUR',
  };
}

function decision(outcome: 'allow' | 'require_approval', world: World): DecisionResult {
  const p = params(world);
  const record = {
    configHash: 'cfg-1',
    request: {
      action: 'issue_refund' as const,
      customerKey: p.customerKey,
      orderId: p.orderId,
      orderItemId: p.orderItemId,
      quantity: p.quantity,
      currency: p.currency,
      amountMinorUnits: p.amountMinorUnits,
    },
    eligibility: [],
    perCap: [],
  };
  return outcome === 'allow' ? { outcome, record } : { outcome, reason: 'cap_exceeded', record };
}

async function pendingRecord(world: World): Promise<RefundLedgerRecord> {
  const result = await world.ledger.recordRefund(params(world), [], () =>
    decision('require_approval', world),
  );
  if (result.outcome === 'deny') throw new Error('test bug');
  return result.ledgerRecord;
}

describe('inbox actions', () => {
  it('lists pending records with a conversation summary', async () => {
    const world = await setup();
    const record = await pendingRecord(world);

    const items = await world.inbox.listPending();

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      record: { id: record.id, status: 'pending' },
      conversation: {
        id: world.conversationId,
        turns: 1,
        lastCustomerMessage: 'Refund the jacket please, it has a cut.',
      },
    });
  });

  it('approve moves the record through attempted to ok, executes once, and audits who did it', async () => {
    const world = await setup();
    const record = await pendingRecord(world);

    const result = await world.inbox.approve(record.id, 'dragos');

    expect(result).toMatchObject({
      status: 'done',
      record: { status: 'ok', refundedAmountMinorUnits: 15_900 },
      execution: { status: 'settled' },
      audit: {
        type: 'refund',
        action: 'approve',
        actor: 'dragos',
        recordId: record.id,
        statusBefore: 'pending',
        statusAfter: 'ok',
        promptHash: 'hash-1',
        configHash: 'cfg-1',
      },
    });
    expect(await world.audit.listEntries()).toHaveLength(1);
  });

  it('a second approve, and a deny after approve, are refused by the transition table without a throw', async () => {
    const world = await setup();
    const record = await pendingRecord(world);
    await world.inbox.approve(record.id, 'dragos');

    expect(await world.inbox.approve(record.id, 'dragos')).toEqual({
      status: 'refused',
      reason: 'illegal_transition',
      ledgerStatus: 'ok',
    });
    expect(await world.inbox.deny(record.id, 'dragos')).toMatchObject({
      status: 'refused',
      reason: 'illegal_transition',
    });
    expect(await world.audit.listEntries()).toHaveLength(1);
  });

  it('deny closes the record and audits it; the refund is never executed', async () => {
    const world = await setup();
    const record = await pendingRecord(world);

    const result = await world.inbox.deny(record.id, 'dragos');

    expect(result).toMatchObject({
      status: 'done',
      record: { status: 'denied' },
      audit: { action: 'deny', statusBefore: 'pending', statusAfter: 'denied' },
    });
    expect(result).not.toHaveProperty('execution');
  });

  it('unknown ids are refused as such', async () => {
    const world = await setup();
    expect(await world.inbox.approve('nope', 'dragos')).toEqual({
      status: 'refused',
      reason: 'record_not_found',
    });
    expect(await world.inbox.getRefund('nope')).toBeNull();
  });

  it('reconcile lists and replays a crash signature once it is older than the window', async () => {
    const world = await setup();
    const result = await world.ledger.recordRefund(params(world), [], () =>
      decision('allow', world),
    );
    if (result.outcome === 'deny') throw new Error('test bug');
    const attempted = result.ledgerRecord; // backend never called: the crash signature

    expect(await world.inbox.listNeedingReconciliation(WINDOW_MS)).toEqual([]);
    expect(await world.inbox.reconcile(attempted.id, 'dragos', WINDOW_MS)).toEqual({
      status: 'refused',
      reason: 'in_flight',
      ledgerStatus: 'attempted',
    });

    world.clock.now += WINDOW_MS + 1;
    expect(await world.inbox.listNeedingReconciliation(WINDOW_MS)).toHaveLength(1);
    const reconciled = await world.inbox.reconcile(attempted.id, 'dragos', WINDOW_MS);

    expect(reconciled).toMatchObject({
      status: 'done',
      record: { status: 'ok' },
      audit: { action: 'reconcile', statusBefore: 'attempted', statusAfter: 'ok' },
    });
  });

  it('the detail carries the record, the transcript and the audit trail for that record', async () => {
    const world = await setup();
    const record = await pendingRecord(world);
    await world.inbox.deny(record.id, 'dragos');

    const detail = await world.inbox.getRefund(record.id);

    expect(detail?.record.status).toBe('denied');
    expect(detail?.conversation?.messages).toHaveLength(2);
    expect(detail?.auditEntries.map((entry) => entry.action)).toEqual(['deny']);
  });

  it('take over marks the conversation once and audits it', async () => {
    const world = await setup();

    const first = await world.inbox.takeOver(world.conversationId, 'dragos');
    const again = await world.inbox.takeOver(world.conversationId, 'dragos');

    expect(first).toMatchObject({
      status: 'done',
      conversation: { takeOver: { actor: 'dragos', takenOverAt: NOW } },
      audit: { type: 'conversation', action: 'take_over', actor: 'dragos' },
    });
    expect(again).toMatchObject({ status: 'refused', reason: 'already_taken_over' });
    expect(await world.inbox.takeOver('nope', 'dragos')).toEqual({
      status: 'refused',
      reason: 'conversation_not_found',
    });
    expect((await world.store.findConversation(world.conversationId))?.takeOver).toMatchObject({
      actor: 'dragos',
    });
    expect(await world.audit.listEntries({ conversationId: world.conversationId })).toHaveLength(1);
  });
});
