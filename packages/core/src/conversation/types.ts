import type { Message } from "../messages.js";

export type Conversation = {
    id: string;
    messages: Message[];
}
