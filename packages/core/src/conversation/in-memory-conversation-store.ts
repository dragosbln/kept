import type { Message } from '../messages.js';
import type { VerifiedEmails } from '../identity/types.js';
import type { ConversationStore } from './conversation-store.js';
import type { Conversation, ConversationTakeover } from './types.js';

/** A deep-enough copy: the arrays a caller could mutate are fresh, the rest is immutable. */
function copyConversation(conversation: Conversation): Conversation {
  return {
    ...conversation,
    messages: [...conversation.messages],
    ...(conversation.verifiedEmails ? { verifiedEmails: [...conversation.verifiedEmails] } : {}),
  };
}

export class InMemoryConversationStore implements ConversationStore {
  private conversations: Conversation[];

  constructor(seededConversations?: Conversation[]) {
    this.conversations = seededConversations ? seededConversations.map(copyConversation) : [];
  }

  private indexOf(id: string): number {
    const index = this.conversations.findIndex((conv) => conv.id === id);
    if (index === -1) {
      throw new Error(`Conversation with id ${id} doesn't exist`);
    }
    return index;
  }

  async findConversation(id: string): Promise<Conversation | null> {
    const conversation = this.conversations.find((conv) => conv.id === id);
    return conversation ? copyConversation(conversation) : null;
  }

  async createNewConversation(): Promise<Conversation> {
    const newConversation: Conversation = {
      id: crypto.randomUUID(),
      messages: [],
    };

    this.conversations.push(newConversation);
    return copyConversation(newConversation);
  }

  async updateConversationHistory(id: string, updatedHistory: Message[]): Promise<Conversation> {
    const conversation = this.conversations[this.indexOf(id)]!;
    conversation.messages = [...updatedHistory];
    return copyConversation(conversation);
  }

  async markTakeOver(id: string, takeOver: ConversationTakeover): Promise<Conversation> {
    const conversation = this.conversations[this.indexOf(id)]!;
    conversation.takeOver = { ...takeOver };
    return copyConversation(conversation);
  }

  async updateVerifiedEmails(id: string, verifiedEmails: VerifiedEmails): Promise<Conversation> {
    const conversation = this.conversations[this.indexOf(id)]!;
    conversation.verifiedEmails = [...verifiedEmails];
    return copyConversation(conversation);
  }
}
