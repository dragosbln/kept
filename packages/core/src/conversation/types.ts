import type { Message } from '../messages.js';

/** A human took the conversation over: the agent stops answering it. */
export type ConversationTakeover = {
  takenOverAt: number;
  actor: string;
};

export type Conversation = {
  id: string;
  takeOver?: ConversationTakeover;
  messages: Message[];
};
