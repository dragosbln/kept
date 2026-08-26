import type { Message } from '../messages.js';
import type { ConversationStore } from './conversation-store.js';
import type { Conversation } from './types.js';

export class InMemoryConversationStore implements ConversationStore {
  private conversations: Conversation[];

  constructor(seededConversations?: Conversation[]) {
    this.conversations = seededConversations
      ? seededConversations.map((conv) => ({ ...conv, messages: [...conv.messages] }))
      : [];
  }

  private copyOut(conversation: Conversation): Conversation {
    return { ...conversation, messages: [...conversation.messages] };
  }

  async findConversation(id: string): Promise<Conversation | null> {
    const conversation = this.conversations.find((conv) => conv.id === id);
    return conversation ? this.copyOut(conversation) : null;
  }

  async createNewConversation(): Promise<Conversation> {
    const newConversation: Conversation = {
      id: crypto.randomUUID(),
      messages: [],
    };

    this.conversations.push(newConversation);
    return this.copyOut(newConversation);
  }

  async updateConversationHistory(id: string, updatedHistory: Message[]): Promise<Conversation> {
    const conversationIndex = this.conversations.findIndex((conv) => conv.id === id);
    if (conversationIndex === -1) {
      throw new Error(`Conversation with id ${id} doesn't exist`);
    }
    this.conversations[conversationIndex]!.messages = [...updatedHistory];
    return this.copyOut(this.conversations[conversationIndex]!);
  }
}
