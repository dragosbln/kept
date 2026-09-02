import { z } from 'zod';
import type { ToolRegistry, ToolResult } from '../tools/types.js';
import type { ExecuteToolCallArgs, ExecuteToolParams, SettledToolCall } from './types.js';

export const EXECUTOR_TIMEOUT_MS = 10_000;

const TIMED_OUT = Symbol('timeout');

type CreateTimeoutReturnType = {
  promise: Promise<typeof TIMED_OUT>;
  cancel: () => void;
};

function createTimeout(ms: number): CreateTimeoutReturnType {
  let timeoutRef: NodeJS.Timeout | null = null;
  return {
    promise: new Promise((resolve) => {
      timeoutRef = setTimeout(() => resolve(TIMED_OUT), ms);
    }),
    cancel: () => timeoutRef && clearTimeout(timeoutRef),
  };
}

export async function executeTool<TSchema extends z.ZodType>({
  tool: { inputSchema, execute },
  input,
  ctx,
  timeoutMs = EXECUTOR_TIMEOUT_MS,
}: ExecuteToolParams<TSchema>): Promise<ToolResult> {
  const timeout = createTimeout(timeoutMs);

  try {
    const parsedInput = inputSchema.parse(input);

    const executePromise = execute(parsedInput, ctx);

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
    if (error instanceof z.ZodError) {
      return {
        resultState: 'failed',
        result: error.issues,
        response: `Invalid input: ${z.prettifyError(error)}`,
      };
    }

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
  timeoutMs?: number,
): Promise<SettledToolCall> {
  if (!Object.keys(registry).includes(name)) {
    return {
      callId,
      resultState: 'failed',
      result: { requestedTool: name },
      response: `Invalid tool name: ${name} does not exist in tool registry`,
    };
  }

  const tool = registry[name as keyof typeof registry];

  const result = await executeTool({
    tool,
    input: args,
    ctx: { callId },
    timeoutMs,
  });

  return {
    callId,
    ...result,
  };
}
