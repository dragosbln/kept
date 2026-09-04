// runTurn: one customer message in, one TurnOutcome out. A turn is a small
// state machine, and this file is written to read as its transition table.
// `replied`, `failed(...)` and `conversation_full` are the terminals.
//
//   state             event                          next
//   (start)           runTurn(message)               awaiting_model
//   awaiting_model    tool_use, rounds left          executing_tools
//   awaiting_model    tool_use, budget spent         failed(max_rounds)
//   awaiting_model    end_turn with text             replied
//   awaiting_model    end_turn without text          failed(empty_reply)
//   awaiting_model    refusal | max_tokens           failed(refusal | max_tokens)
//   awaiting_model    unknown stop reason            failed(unknown_stop_reason)
//   awaiting_model    transport_error                failed(internal)
//   awaiting_model    context_window_exceeded        conversation_full
//   executing_tools   all tools settled              awaiting_model
//
// Invariants:
// - Every tool_use is answered by exactly one tool_result, and all results of
//   a round travel in a single user message.
// - Failed terminals are atomic: the caller's history comes back unchanged,
//   and the trace records what history omits. Only `replied` commits the turn.
// - No span is left in_progress at a terminal; the turn span closes with the
//   outcome.
// - Errors become outcomes; nothing throws across the runTurn boundary.
// - Single-flight: the caller holds the conversation lock and the loop awaits
//   each step, so no two events overlap inside a turn.
// - The loop never speaks HTTP and never ends the trace; the host does both.

import type { Message, MessagePart } from '../messages.js';
import type { ModelClient } from '../model/client.js';
import type { CallModelResponse, ModelClientConfig } from '../model/types.js';
import type { ModelCallSpan, TurnSpan } from '../tracing/span.js';
import type { Trace } from '../tracing/trace.js';
import type { TurnFailureReason } from '../tracing/types.js';
import type { ToolRegistry } from '../tools/types.js';
import { executeToolCall } from './executor.js';
import type { RunTurnParams, RunTurnResult } from './types.js';

const MAX_ROUNDS = 10;

/**
 * Where a turn can end. The loop returns one of these and nothing else; the
 * mapping to the customer-facing TurnOutcome happens once, in runTurn.
 * `replied` is the only terminal that carries a history, which makes
 * "persist only on reply" a property of the type rather than a rule to
 * remember.
 */
type Terminal =
  | { state: 'replied'; reply: string; history: Message[] }
  | { state: 'failed'; reason: TurnFailureReason }
  | { state: 'conversation_full' };

/**
 * What every round of one turn shares; built once by runTurn. The model
 * config is read once here because the client clones it on every getConfig().
 */
type LoopContext = {
  modelClient: ModelClient;
  modelConfig: Readonly<ModelClientConfig>;
  tools: ToolRegistry;
  trace: Trace;
  turnSpanId: string;
  maxRounds: number;
};

export async function runTurn({
  conversation,
  message,
  modelClient,
  tools,
  trace,
  maxRounds = MAX_ROUNDS,
}: RunTurnParams): Promise<RunTurnResult> {
  let turnSpan: TurnSpan | undefined;

  try {
    const history: Message[] = [
      ...conversation.messages,
      { role: 'user', parts: [{ type: 'text', content: message }] },
    ];

    turnSpan = trace.startTurnSpan(null, { customerInput: message });

    const terminal = await runLoop(history, {
      modelClient,
      modelConfig: modelClient.getConfig(),
      tools,
      trace,
      turnSpanId: turnSpan.id,
      maxRounds,
    });

    const result = toTurnResult(terminal, conversation.messages);
    turnSpan.end({ outcome: result.outcome });
    return result;
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

/**
 * The transition table, one round per iteration: awaiting_model, then either
 * a terminal or executing_tools and back. `round` counts completed tool
 * rounds; see RunTurnParams.maxRounds for how the budget is spent.
 */
async function runLoop(history: Message[], ctx: LoopContext): Promise<Terminal> {
  // Rebuilt every round, never pushed: each round's model_call span holds a
  // reference to that round's `messages` as its inputMessages and must not
  // see later rounds appended to it.
  let messages = history;

  // Rounds are sequential by design: each model call needs the previous
  // round's tool results, and single-flight holds because every step is
  // awaited before the next event can occur. The two lint rules disabled
  // here object to exactly those two choices.
  /* oxlint-disable no-await-in-loop, no-accumulating-spread */
  for (let round = 0; ; round++) {
    const response = await tracedModelCall(messages, ctx);

    switch (response.type) {
      case 'tool_use': {
        if (round >= ctx.maxRounds) {
          return { state: 'failed', reason: 'max_rounds' };
        }
        const toolResults = await executeToolRound(response.message, ctx);
        messages = [...messages, response.message, toolResults];
        continue;
      }
      case 'end_turn': {
        const reply = replyText(response.message);
        if (!reply) {
          return { state: 'failed', reason: 'empty_reply' };
        }
        return { state: 'replied', reply, history: [...messages, response.message] };
      }
      case 'refusal':
      case 'max_tokens':
        return { state: 'failed', reason: response.type };
      case 'unknown':
        return { state: 'failed', reason: 'unknown_stop_reason' };
      case 'transport_error':
        return { state: 'failed', reason: 'internal' };
      case 'context_window_exceeded':
        return { state: 'conversation_full' };
      default:
        return assertNever(response);
    }
  }
  /* oxlint-enable no-await-in-loop, no-accumulating-spread */
}

/**
 * Terminal to result. `replied` commits its history; every other terminal
 * hands the caller's history back untouched.
 */
function toTurnResult(terminal: Terminal, priorHistory: Message[]): RunTurnResult {
  switch (terminal.state) {
    case 'replied':
      return {
        outcome: { type: 'reply', message: terminal.reply },
        updatedHistory: terminal.history,
      };
    case 'failed':
      return {
        outcome: { type: 'failed', reason: terminal.reason },
        updatedHistory: priorHistory,
      };
    case 'conversation_full':
      return {
        outcome: { type: 'conversation_full' },
        updatedHistory: priorHistory,
      };
  }
}

/** awaiting_model: one provider round trip, recorded as a model_call span under the turn. */
async function tracedModelCall(messages: Message[], ctx: LoopContext): Promise<CallModelResponse> {
  const { provider, model, promptData } = ctx.modelConfig;
  const span = ctx.trace.startModelCallSpan(ctx.turnSpanId, {
    providerName: provider,
    model,
    promptName: promptData.name,
    promptVersion: promptData.version,
    promptHash: promptData.hash,
    inputMessages: messages,
  });

  try {
    const response = await ctx.modelClient.callModel(messages);
    closeModelCallSpan(span, response);
    return response;
  } catch (error) {
    // The client's contract is "never rejects"; a throw here is a bug. The
    // span records it before runTurn turns it into failed(internal).
    span.error('_OTHER');
    throw error;
  }
}

/**
 * The model_call span records what the provider returned, whatever the loop
 * decides to do with it: a response that carries a message and usage
 * completes the span even when the turn will fail (refusal, max_tokens...),
 * because the call itself succeeded. Only a call that produced nothing is an
 * error on the span.
 */
function closeModelCallSpan(span: ModelCallSpan, response: CallModelResponse): void {
  if (response.type === 'transport_error') {
    span.error(response.errorType);
    return;
  }

  if (response.message && response.usage) {
    span.end({
      inputTokens: response.usage.inputTokens,
      outputTokens: response.usage.outputTokens,
      outputMessages: [response.message],
    });
    return;
  }

  // context_window_exceeded, request flavour: rejected before generation.
  span.error('context_window_exceeded');
}

/**
 * executing_tools: every tool_call in the assistant message runs in parallel
 * under its own tool_execution span, parented by the turn. All results come
 * back in ONE user message, so each tool_use is answered by exactly one
 * tool_result.
 */
async function executeToolRound(assistantMessage: Message, ctx: LoopContext): Promise<Message> {
  const toolPromises = assistantMessage.parts.flatMap((part) => {
    if (part.type === 'tool_call') {
      const toolSpan = ctx.trace.startToolExecutionSpan(ctx.turnSpanId, {
        toolName: part.name,
        callId: part.id,
        args: part.args,
      });
      return [
        executeToolCall(ctx.tools, {
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

  return {
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
}

/** The customer-visible text of an assistant message; empty when it has no text parts. */
function replyText(message: Message): string {
  return message.parts
    .filter((part) => part.type === 'text')
    .map((part) => part.content)
    .join(' ');
}

/**
 * Compile-time exhaustiveness: a new CallModelResponse variant that the loop
 * does not handle fails to typecheck here instead of falling through.
 */
function assertNever(value: never): never {
  throw new Error(`unhandled model response type: ${(value as { type: string }).type}`);
}
