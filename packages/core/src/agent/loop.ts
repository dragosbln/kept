import type { Message, MessagePart } from '../messages.js';
import type { TurnSpan } from '../tracing/span.js';
import type { TurnOutcome } from '../tracing/types.js';
import { executeToolCall } from './executor.js';
import type {
  RecursiveRunReturnType,
  RecursiveRunTurnParams,
  RunTurnParams,
  RunTurnResult,
} from './types.js';

const MAX_ROUNDS = 10;

async function recursiveRun({
  messages,
  modelClient,
  tools,
  trace,
  turnSpanId,
  round,
  maxRounds = MAX_ROUNDS,
}: RecursiveRunTurnParams): Promise<RecursiveRunReturnType> {
  const messagesCopy = [...messages];

  const { provider, model, promptData } = modelClient.getConfig();

  const callSpan = trace.startModelCallSpan(turnSpanId, {
    providerName: provider,
    model,
    promptName: promptData.name,
    promptVersion: promptData.version,
    promptHash: promptData.hash,
    inputMessages: messages,
  });

  try {
    const response = await modelClient.callModel(messagesCopy);

    if (response.type === 'transport_error') {
      callSpan.error(response.errorType);
    } else if (response.type === 'context_window_exceeded') {
      if (response.message && response.usage) {
        callSpan.end({
          inputTokens: response.usage.inputTokens,
          outputTokens: response.usage.outputTokens,
          outputMessages: [response.message],
        });
      } else {
        callSpan.error('context_window_exceeded');
      }
    } else {
      callSpan.end({
        inputTokens: response.usage.inputTokens,
        outputTokens: response.usage.outputTokens,
        outputMessages: [response.message],
      });
    }

    if (response.type === 'end_turn') {
      return {
        type: response.type,
        messages: [...messagesCopy, response.message],
      };
    } else if (response.type === 'tool_use') {
      if (round >= maxRounds) {
        return {
          type: 'max_rounds',
          messages: messagesCopy,
        };
      }

      const toolPromises = response.message.parts.flatMap((part) => {
        if (part.type === 'tool_call') {
          const toolSpan = trace.startToolExecutionSpan(turnSpanId, {
            toolName: part.name,
            callId: part.id,
            args: part.args,
          });
          return [
            executeToolCall(tools, {
              callId: part.id,
              name: part.name,
              args: part.args,
            })
              .then((value) => {
                toolSpan.end({ result: value.result, resultState: value.resultState });
                return value;
              })
              .catch((error) => {
                toolSpan.error('_OTHER');
                throw error;
              }),
          ];
        }
        return [];
      });

      const results = await Promise.all(toolPromises);

      const toolResultMessage: Message = {
        role: 'user',
        parts: results.map(
          (res) =>
            ({
              type: 'tool_call_response',
              id: res.callId,
              response: res.response,
              status: res.resultState,
            }) as MessagePart,
        ),
      };

      return recursiveRun({
        messages: [...messagesCopy, response.message, toolResultMessage],
        modelClient,
        tools,
        trace,
        turnSpanId,
        round: round + 1,
        maxRounds,
      });
    } else {
      return {
        type: response.type,
        messages: messagesCopy,
      };
    }
  } catch (error) {
    callSpan.error('_OTHER');
    throw error;
  }
}

function createTurnOutcome(response: RecursiveRunReturnType): TurnOutcome {
  let message: string | undefined;
  switch (response.type) {
    case 'end_turn':
      message = response.messages[response.messages.length - 1]?.parts
        .filter((part) => part.type === 'text')
        .map((part) => part.content)
        .join(' ');
      if (!message) {
        return {
          type: 'failed',
          reason: 'empty_reply',
        };
      } else {
        return {
          type: 'reply',
          message,
        };
      }

    case 'context_window_exceeded':
      return {
        type: 'conversation_full',
      };
    case 'transport_error':
      return {
        type: 'failed',
        reason: 'internal',
      };
    case 'max_tokens':
    case 'max_rounds':
    case 'refusal':
      return {
        type: 'failed',
        reason: response.type,
      };
    case 'unknown':
      return {
        type: 'failed',
        reason: 'unknown_stop_reason',
      };
  }
}

export async function runTurn({
  conversation,
  message,
  modelClient,
  tools,
  trace,
  maxRounds,
}: RunTurnParams): Promise<RunTurnResult> {
  let turnSpan: TurnSpan | undefined;

  try {
    const messages = [...conversation.messages];

    messages.push({
      role: 'user',
      parts: [
        {
          type: 'text',
          content: message,
        },
      ],
    });

    turnSpan = trace.startTurnSpan(null, {
      customerInput: message,
    });

    const response = await recursiveRun({
      messages,
      modelClient,
      tools,
      trace,
      turnSpanId: turnSpan.id,
      round: 0,
      maxRounds,
    });

    const outcome = createTurnOutcome(response);

    turnSpan.end({
      outcome,
    });

    return {
      outcome,
      // return history untouched if outcome is not 'reply'
      updatedHistory: outcome.type === 'reply' ? response.messages : conversation.messages,
    };
  } catch (error) {
    console.error(error);

    if (turnSpan) {
      turnSpan.end({
        outcome: {
          type: 'failed',
          reason: 'internal',
        },
      });
    }

    return {
      outcome: {
        type: 'failed',
        reason: 'internal',
      },
      updatedHistory: conversation.messages,
    };
  }
}
