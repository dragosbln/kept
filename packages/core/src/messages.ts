export type MessageRole = 'user' | 'assistant' | 'tool' | 'system';
export type ToolResultState = 'ok' | 'failed' | 'unknown';
export type ToolArgs = Record<string, unknown>;

export type MessagePart =
  | {
      type: 'text';
      content: string;
    }
  | {
      type: 'tool_call';
      id: string;
      name: string;
      args: ToolArgs;
    }
  | {
      type: 'tool_call_response';
      id: string;
      response: string;
      status: ToolResultState;
    };

export type Message = {
  role: MessageRole;
  parts: MessagePart[];
  finishReason?: string;
};
