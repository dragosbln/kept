// The audit log: one entry per human action on the trust layer, appended
// after the action took effect, never edited, never removed. The inbox and
// the record detail read it; nothing else writes to it in v0 (the agent's
// own decisions live on the ledger record and the policy_decision span).

import type { AuditEntry, AuditEntryInput, ListAuditEntriesOptions } from './types.js';

export interface AuditLog {
  append(entry: AuditEntryInput): Promise<AuditEntry>;
  /** Insertion order; both filters narrow when given. */
  listEntries(options?: ListAuditEntriesOptions): Promise<AuditEntry[]>;
}

function copyOut(entry: AuditEntry): AuditEntry {
  return { ...entry };
}

export class InMemoryAuditLog implements AuditLog {
  private entries: AuditEntry[] = [];
  private now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  async append(input: AuditEntryInput): Promise<AuditEntry> {
    const entry: AuditEntry = { ...input, id: crypto.randomUUID(), createdAt: this.now() };
    this.entries.push(entry);
    return copyOut(entry);
  }

  async listEntries(options: ListAuditEntriesOptions = {}): Promise<AuditEntry[]> {
    return this.entries
      .filter(
        (entry) =>
          (options.conversationId === undefined ||
            entry.conversationId === options.conversationId) &&
          (options.recordId === undefined ||
            (entry.type === 'refund' && entry.recordId === options.recordId)),
      )
      .map(copyOut);
  }
}
