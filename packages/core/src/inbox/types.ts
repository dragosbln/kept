import type { Conversation, ConversationTakeover } from '../conversation/types.js';
import type { RefundExecution } from '../refunds/execute.js';
import type { RefundLedgerRecord, RefundLedgerRecordStatus } from '../refund-ledger/types.js';

export type RefundAction = 'approve' | 'deny' | 'reconcile';

export type ConversationAction = 'take_over';

type AuditEntryBase = {
  id: string;
  createdAt: number;
  /** A name in v0: no auth, the header on the request. */
  actor: string;
  conversationId: string;
};

/** A human's decision on one ledger record, with what it changed and what the backend did. */
export type RefundAuditEntry = AuditEntryBase & {
  type: 'refund';
  action: RefundAction;
  recordId: string;
  statusBefore: RefundLedgerRecordStatus;
  statusAfter: RefundLedgerRecordStatus;
  execution?: RefundExecution;
  promptHash: string;
  configHash: string;
};

export type ConversationAuditEntry = AuditEntryBase & {
  type: 'conversation';
  action: ConversationAction;
};

export type AuditEntry = RefundAuditEntry | ConversationAuditEntry;

export type AuditEntryInput =
  Omit<RefundAuditEntry, 'id' | 'createdAt'> | Omit<ConversationAuditEntry, 'id' | 'createdAt'>;

export type ListAuditEntriesOptions = {
  conversationId?: string;
  recordId?: string;
};

/**
 * What the queue row shows of a conversation. Conversations carry no
 * timestamps yet, so the record's createdAt is the time on the row.
 */
export type ConversationSummary = {
  id: string;
  /** Customer messages so far. */
  turns: number;
  lastCustomerMessage: string;
  takeOver?: ConversationTakeover;
};

export type InboxRefundItem = {
  record: RefundLedgerRecord;
  /** Null when the conversation is gone; the row still renders from the record. */
  conversation: ConversationSummary | null;
};

export type InboxRefundDetail = {
  record: RefundLedgerRecord;
  conversation: Conversation | null;
  auditEntries: AuditEntry[];
};

/**
 * Why an action did nothing. `illegal_transition` is the transition table
 * refusing, which is what makes a double click safe; `in_flight` is a
 * reconcile on an attempted record younger than the window.
 */
export type ActionRefusal =
  | { status: 'refused'; reason: 'record_not_found' | 'conversation_not_found' }
  | {
      status: 'refused';
      reason: 'illegal_transition' | 'in_flight';
      ledgerStatus: RefundLedgerRecordStatus;
    }
  | { status: 'refused'; reason: 'already_taken_over'; takeOver: ConversationTakeover };

export type RefundActionResult =
  | {
      status: 'done';
      /** The record as it is after the action, re-read from the ledger. */
      record: RefundLedgerRecord;
      execution?: RefundExecution;
      audit: RefundAuditEntry;
    }
  | ActionRefusal;

export type TakeOverResult =
  { status: 'done'; conversation: Conversation; audit: ConversationAuditEntry } | ActionRefusal;

export interface InboxActions {
  listPending(): Promise<InboxRefundItem[]>;
  /** Unknown records and crash signatures older than `windowMs`. */
  listNeedingReconciliation(windowMs: number): Promise<InboxRefundItem[]>;
  getRefund(recordId: string): Promise<InboxRefundDetail | null>;
  listAudit(options?: ListAuditEntriesOptions): Promise<AuditEntry[]>;
  approve(recordId: string, actor: string): Promise<RefundActionResult>;
  deny(recordId: string, actor: string): Promise<RefundActionResult>;
  reconcile(recordId: string, actor: string, windowMs: number): Promise<RefundActionResult>;
  takeOver(conversationId: string, actor: string): Promise<TakeOverResult>;
}
