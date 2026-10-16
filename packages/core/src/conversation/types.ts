import type { Message } from '../messages.js';
import type { VerifiedEmails } from '../identity/types.js';

/** A human took the conversation over: the agent stops answering it. */
export type ConversationTakeover = {
  takenOverAt: number;
  actor: string;
};

export type Conversation = {
  id: string;
  takeOver?: ConversationTakeover;
  messages: Message[];
  /**
   * The emails this conversation has proved through verify_identity (block
   * 5). Absent means none. Grows only; the host persists it after a turn.
   */
  verifiedEmails?: VerifiedEmails;
};
