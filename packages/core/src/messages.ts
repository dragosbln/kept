export type MessageRole = 'user' | 'assistant';
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

/** The tool-call member of MessagePart, for code that handles tool calls alone. */
export type ToolCallPart = Extract<MessagePart, { type: 'tool_call' }>;

export type Message = {
  role: MessageRole;
  parts: MessagePart[];
  finishReason?: string;
};

/**
 * Well-known error classes; the list grows as fault toggles land.
 * `context_window_exceeded` is a model call rejected before generation
 * because the request itself no longer fits the window. `_OTHER` is OTel's
 * conventional fallback for "an error outside the known classes".
 */
export type WellKnownErrorType = 'timeout' | 'context_window_exceeded' | '_OTHER';

/**
 * Low-cardinality error identifier, OTel `error.type` style: prefer a
 * WellKnownErrorType, otherwise any stable identifier (an HTTP status code,
 * an exception class name) — never free-form message text, so errors stay
 * groupable in dashboards and eval assertions.
 */
export type ErrorType = WellKnownErrorType | (string & {});
