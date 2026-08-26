// interface ConversationStore

import type { Message } from '../messages.js';
import type { Conversation } from './types.js';

export interface ConversationStore {
  findConversation(id: string): Promise<Conversation | null>;
  createNewConversation(): Promise<Conversation>;
  /** Throws if conversation with specified ID doesn't exist */
  updateConversationHistory(id: string, updatedHistory: Message[]): Promise<Conversation>;
}
