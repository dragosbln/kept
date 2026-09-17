import type { Message } from '../messages.js';
import type { Conversation, ConversationTakeover } from './types.js';

export interface ConversationStore {
  findConversation(id: string): Promise<Conversation | null>;
  createNewConversation(): Promise<Conversation>;
  /** Throws if conversation with specified ID doesn't exist */
  updateConversationHistory(id: string, updatedHistory: Message[]): Promise<Conversation>;
  /** Marks the conversation as taken over by a human. Throws if it doesn't exist. */
  markTakeOver(id: string, takeOver: ConversationTakeover): Promise<Conversation>;
}
