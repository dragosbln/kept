import { z } from 'zod';
import type { ToolName, ToolRegistry, ToolResult } from '../tools/types.js';
import type { ExecuteToolCallArgs, ExecuteToolParams, SettledToolCall } from './types.js';

export const DEFAULT_TOOL_TIMEOUT_MS = 10_000;

const TIMED_OUT = Symbol('timeout');

type ToolTimeout = {
  promise: Promise<typeof TIMED_OUT>;
  signal: AbortSignal;
  cancel: () => void;
};

/**
 * One timer, two effects: the race sentinel that settles the call as
 * `unknown`, and an abort signal so a tool that can stop in-flight work
 * does. cancel() disarms both once the tool has settled on its own.
 */
function createTimeout(ms: number): ToolTimeout {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const promise = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve(TIMED_OUT);
    }, ms);
  });
  return {
    promise,
    signal: controller.signal,
    cancel: () => {
      clearTimeout(timer);
    },
  };
}

/** Prototype-safe membership test that also narrows `name` for the lookup. */
function isRegisteredTool(registry: ToolRegistry, name: string): name is ToolName {
  return Object.hasOwn(registry, name);
}

export async function executeTool<TSchema extends z.ZodType>({
  tool: { inputSchema, execute },
  input,
  callId,
  timeoutMs = DEFAULT_TOOL_TIMEOUT_MS,
}: ExecuteToolParams<TSchema>): Promise<ToolResult> {
  const parsed = inputSchema.safeParse(input);

  if (!parsed.success) {
    return {
      resultState: 'failed',
      result: parsed.error.issues,
      response: `Invalid input: ${z.prettifyError(parsed.error)}`,
    };
  }

  const timeout = createTimeout(timeoutMs);

  try {
    const executePromise = execute(parsed.data, { callId, signal: timeout.signal });

    // A rejection that lands after the race has settled (a tool failing late,
    // after its timeout) must not surface as an unhandled rejection.
    executePromise.catch(() => {});

    const result = await Promise.race([executePromise, timeout.promise]);

    if (result === TIMED_OUT) {
      return {
        resultState: 'unknown',
        result: { timeoutAfterMs: timeoutMs },
        response: 'Tool execution timed out. Do not retry.',
      };
    }

    return result;
  } catch (error) {
    return {
      resultState: 'failed',
      result:
        error instanceof Error
          ? { errorName: error.name, errorMessage: error.message }
          : { errorMessage: String(error) },
      response: 'Tool call failed.',
    };
  } finally {
    timeout.cancel();
  }
}

export async function executeToolCall(
  registry: ToolRegistry,
  { callId, name, args }: ExecuteToolCallArgs,
  timeoutMs = DEFAULT_TOOL_TIMEOUT_MS,
): Promise<SettledToolCall> {
  if (!isRegisteredTool(registry, name)) {
    return {
      callId,
      resultState: 'failed',
      result: { requestedTool: name },
      response: `Invalid tool name: ${name} does not exist in tool registry`,
    };
  }

  const result = await executeTool({ tool: registry[name], input: args, callId, timeoutMs });

  return { callId, ...result };
}
