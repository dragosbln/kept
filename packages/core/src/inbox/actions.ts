// The inbox's state machine over the ledger, the backend and the store:
// approve, deny, reconcile a refund record; take over a conversation. Every
// action that took effect appends one audit entry. Approve is a human
// override, not a re-decision: the caps are not re-evaluated, the decision
// on the record still says require_approval, and the entry says who.
//
// Invariants:
// - Nothing here throws for a human's second click. The ledger refuses an
//   illegal edge with LedgerError; the service turns it into a typed refusal.
// - Approve is two steps, pending -> attempted, then the shared write path.
//   A crash between them leaves the crash signature, which reconcile
//   already handles.
// - Results carry the record re-read from the ledger, so the caller sees
//   the state after the action, whatever the execution came to.

import type { OrderBackend } from '../backend/order-backend.js';
import type { ConversationStore } from '../conversation/conversation-store.js';
import type { Conversation } from '../conversation/types.js';
import {
  LedgerError,
  isCrashSignature,
  type RefundLedger,
} from '../refund-ledger/refund-ledger.js';
import type { RefundLedgerRecord, RefundLedgerRecordStatus } from '../refund-ledger/types.js';
import { executeRefund, type RefundExecution } from '../refunds/execute.js';
import { reconcileRefund } from '../refunds/reconcile.js';
import type { AuditLog } from './audit-log.js';
import type {
  ActionRefusal,
  AuditEntry,
  ConversationSummary,
  InboxActions,
  InboxRefundDetail,
  InboxRefundItem,
  ListAuditEntriesOptions,
  RefundAction,
  RefundActionResult,
  TakeOverResult,
} from './types.js';

export type InboxDeps = {
  ledger: RefundLedger;
  backend: OrderBackend;
  store: ConversationStore;
  audit: AuditLog;
  /** Injectable clock for the reconciliation window and the take-over mark. */
  now?: () => number;
};

const LAST_MESSAGE_PREVIEW_CHARS = 160;

type Done = Extract<RefundActionResult, { status: 'done' }>;

function summarize(conversation: Conversation): ConversationSummary {
  const customerTexts = conversation.messages
    .filter((message) => message.role === 'user')
    .flatMap((message) => message.parts)
    .filter((part) => part.type === 'text')
    .map((part) => part.content);
  const last = customerTexts.at(-1) ?? '';
  return {
    id: conversation.id,
    turns: customerTexts.length,
    lastCustomerMessage:
      last.length > LAST_MESSAGE_PREVIEW_CHARS
        ? `${last.slice(0, LAST_MESSAGE_PREVIEW_CHARS)}…`
        : last,
    ...(conversation.takeOver ? { takeOver: conversation.takeOver } : {}),
  };
}

/** The record's status once an execution has run, whatever it came to. */
function statusAfter(
  execution: RefundExecution,
  fallback: RefundLedgerRecordStatus,
): RefundLedgerRecordStatus {
  switch (execution.status) {
    case 'settled':
      return execution.ledgerRecord.status;
    case 'unknown':
      return execution.ledgerRecord?.status ?? fallback;
    case 'not_attempted':
      return execution.ledgerStatus;
    default:
      execution satisfies never;
      return fallback;
  }
}

/** The ledger's refusal as the inbox reports it. Anything else is a bug and propagates. */
function refusalFrom(error: unknown, record: RefundLedgerRecord): ActionRefusal {
  if (error instanceof LedgerError && error.errorType === 'illegal_transition') {
    return { status: 'refused', reason: 'illegal_transition', ledgerStatus: record.status };
  }
  throw error;
}

export class InboxService implements InboxActions {
  private readonly ledger: RefundLedger;
  private readonly backend: OrderBackend;
  private readonly store: ConversationStore;
  private readonly audit: AuditLog;
  private readonly now: () => number;

  constructor({ ledger, backend, store, audit, now = Date.now }: InboxDeps) {
    this.ledger = ledger;
    this.backend = backend;
    this.store = store;
    this.audit = audit;
    this.now = now;
  }

  // --- Reads ----------------------------------------------------------------

  async listPending(): Promise<InboxRefundItem[]> {
    const pending = (await this.ledger.list()).filter((record) => record.status === 'pending');
    return Promise.all(pending.map((record) => this.itemFor(record)));
  }

  async listNeedingReconciliation(windowMs: number): Promise<InboxRefundItem[]> {
    const sinceMs = this.now() - windowMs;
    const candidates = (await this.ledger.list()).filter(
      (record) => record.status === 'unknown' || isCrashSignature(record, sinceMs),
    );
    return Promise.all(candidates.map((record) => this.itemFor(record)));
  }

  async getRefund(recordId: string): Promise<InboxRefundDetail | null> {
    const record = await this.ledger.findRecord(recordId);
    if (!record) return null;
    const [conversation, auditEntries] = await Promise.all([
      this.store.findConversation(record.conversationId),
      this.audit.listEntries({ recordId }),
    ]);
    return { record, conversation, auditEntries };
  }

  listAudit(options?: ListAuditEntriesOptions): Promise<AuditEntry[]> {
    return this.audit.listEntries(options);
  }

  // --- Actions --------------------------------------------------------------

  async approve(recordId: string, actor: string): Promise<RefundActionResult> {
    const record = await this.ledger.findRecord(recordId);
    if (!record) return { status: 'refused', reason: 'record_not_found' };
    let attempted: RefundLedgerRecord;
    try {
      attempted = await this.ledger.updateRefundRecordStatus(recordId, 'attempted');
    } catch (error) {
      return refusalFrom(error, record);
    }
    const execution = await executeRefund(attempted, this.ledger, this.backend);
    return this.auditRefund(
      record,
      'approve',
      actor,
      statusAfter(execution, 'attempted'),
      execution,
    );
  }

  async deny(recordId: string, actor: string): Promise<RefundActionResult> {
    const record = await this.ledger.findRecord(recordId);
    if (!record) return { status: 'refused', reason: 'record_not_found' };
    try {
      const denied = await this.ledger.updateRefundRecordStatus(recordId, 'denied');
      return await this.auditRefund(record, 'deny', actor, denied.status);
    } catch (error) {
      return refusalFrom(error, record);
    }
  }

  async reconcile(recordId: string, actor: string, windowMs: number): Promise<RefundActionResult> {
    const record = await this.ledger.findRecord(recordId);
    if (!record) return { status: 'refused', reason: 'record_not_found' };
    const result = await reconcileRefund(recordId, this.ledger, this.backend, {
      now: this.now(),
      windowMs,
    });
    if (result.status === 'skipped') {
      switch (result.reason) {
        case 'record_not_found':
          return { status: 'refused', reason: 'record_not_found' };
        case 'in_flight':
          return { status: 'refused', reason: 'in_flight', ledgerStatus: result.ledgerStatus };
        case 'not_reconcilable':
          return {
            status: 'refused',
            reason: 'illegal_transition',
            ledgerStatus: result.ledgerStatus,
          };
        default:
          result satisfies never;
          return { status: 'refused', reason: 'record_not_found' };
      }
    }
    return this.auditRefund(record, 'reconcile', actor, statusAfter(result, record.status), result);
  }

  async takeOver(conversationId: string, actor: string): Promise<TakeOverResult> {
    const conversation = await this.store.findConversation(conversationId);
    if (!conversation) return { status: 'refused', reason: 'conversation_not_found' };
    if (conversation.takeOver) {
      return { status: 'refused', reason: 'already_taken_over', takeOver: conversation.takeOver };
    }
    const updated = await this.store.markTakeOver(conversationId, {
      takenOverAt: this.now(),
      actor,
    });
    const entry = await this.audit.append({
      type: 'conversation',
      action: 'take_over',
      actor,
      conversationId,
    });
    if (entry.type !== 'conversation') {
      throw new Error('audit log returned a refund entry for a take-over');
    }
    return { status: 'done', conversation: updated, audit: entry };
  }

  // --- Helpers --------------------------------------------------------------

  private async itemFor(record: RefundLedgerRecord): Promise<InboxRefundItem> {
    const conversation = await this.store.findConversation(record.conversationId);
    return { record, conversation: conversation ? summarize(conversation) : null };
  }

  /** Appends the entry for an action that took effect and returns the record as it now is. */
  private async auditRefund(
    record: RefundLedgerRecord,
    action: RefundAction,
    actor: string,
    after: RefundLedgerRecordStatus,
    execution?: RefundExecution,
  ): Promise<Done> {
    const entry = await this.audit.append({
      type: 'refund',
      action,
      actor,
      recordId: record.id,
      conversationId: record.conversationId,
      statusBefore: record.status,
      statusAfter: after,
      promptHash: record.promptHash,
      configHash: record.decisionRecord.record.configHash,
      ...(execution ? { execution } : {}),
    });
    if (entry.type !== 'refund') {
      throw new Error('audit log returned a conversation entry for a refund action');
    }
    const latest = (await this.ledger.findRecord(record.id)) ?? record;
    return { status: 'done', record: latest, audit: entry, ...(execution ? { execution } : {}) };
  }
}
