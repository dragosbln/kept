// Unit tests for the tool-execution wrapper. The contract under test: every
// call settles to a ToolResult — validation failure, thrown error, timeout,
// and unknown tool name are results, never rejections — with the model-facing
// `response` curated (no internal error text) and the trace-facing `result`
// carrying the serialized detail.

import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { executeToolCall } from './executor.js';
import { defineTool } from '../tools/utils.js';
import type { ToolRegistry } from '../tools/types.js';

const schema = z.object({ orderId: z.string().trim() });

type Execute = Parameters<typeof defineTool<typeof schema>>[0]['execute'];

function registryWith(execute: Execute): ToolRegistry {
  return {
    lookup_order: defineTool({ description: 'test tool', inputSchema: schema, execute }),
  };
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe('executeToolCall', () => {
  it('runs the tool with the parsed input and stamps the callId once', async () => {
    let received: { input: unknown; callId: string } | undefined;
    const registry = registryWith(async (input, ctx) => {
      received = { input, callId: ctx.callId };
      return { resultState: 'ok', result: { found: true }, response: 'done' };
    });

    const settled = await executeToolCall(registry, {
      callId: 'call-1',
      name: 'lookup_order',
      args: { orderId: '  order-7  ' },
    });

    // .trim() in the schema proves the tool got the PARSED value, not the raw args.
    expect(received).toEqual({ input: { orderId: 'order-7' }, callId: 'call-1' });
    expect(settled).toEqual({
      callId: 'call-1',
      resultState: 'ok',
      result: { found: true },
      response: 'done',
    });
  });

  it('settles invalid input as failed without running the tool, with a legible response', async () => {
    let toolRan = false;
    const registry = registryWith(async () => {
      toolRan = true;
      return { resultState: 'ok', result: null, response: 'unreachable' };
    });

    const settled = await executeToolCall(registry, {
      callId: 'call-2',
      name: 'lookup_order',
      args: { orderId: 42 },
    });

    expect(toolRan).toBe(false);
    expect(settled.resultState).toBe('failed');
    // The model must be able to self-correct: the offending field is named,
    // and the [object Object] failure mode stays dead.
    expect(settled.response).toContain('orderId');
    expect(settled.response).not.toContain('[object Object]');
    expect(Array.isArray(settled.result)).toBe(true);
  });

  it('settles a thrown Error as failed: detail in result, none of it in response', async () => {
    const registry = registryWith(async () => {
      throw new Error('db exploded at 10.0.0.7');
    });

    const settled = await executeToolCall(registry, {
      callId: 'call-3',
      name: 'lookup_order',
      args: { orderId: 'order-7' },
    });

    expect(settled.resultState).toBe('failed');
    expect(settled.result).toEqual({ errorName: 'Error', errorMessage: 'db exploded at 10.0.0.7' });
    expect(settled.response).not.toContain('db exploded');
  });

  it('settles a non-Error throw as failed with a JSON-serializable result', async () => {
    const registry = registryWith(async () => {
      throw 'catastrophe';
    });

    const settled = await executeToolCall(registry, {
      callId: 'call-4',
      name: 'lookup_order',
      args: { orderId: 'order-7' },
    });

    expect(settled.resultState).toBe('failed');
    expect(settled.result).toEqual({ errorMessage: 'catastrophe' });
    // The trace exporter JSON.stringifies result — it must survive that.
    expect(JSON.parse(JSON.stringify(settled.result))).toEqual(settled.result);
  });

  it('settles a hung tool as unknown with the do-not-retry warning', async () => {
    const registry = registryWith(() => new Promise(() => {}));

    const settled = await executeToolCall(
      registry,
      { callId: 'call-5', name: 'lookup_order', args: { orderId: 'order-7' } },
      15,
    );

    expect(settled.resultState).toBe('unknown');
    expect(settled.result).toEqual({ timeoutAfterMs: 15 });
    expect(settled.response).toContain('Do not retry');
  });

  it('survives a rejection that lands after the timeout already settled the call', async () => {
    const registry = registryWith(
      () =>
        new Promise((_resolve, reject) => {
          setTimeout(() => reject(new Error('late failure')), 40);
        }),
    );

    const settled = await executeToolCall(
      registry,
      { callId: 'call-6', name: 'lookup_order', args: { orderId: 'order-7' } },
      10,
    );
    expect(settled.resultState).toBe('unknown');

    // Let the late rejection actually fire: without the pre-race no-op catch
    // it would surface as an unhandled rejection and fail the test run.
    await sleep(80);
  });

  it('settles an unknown tool name as failed without dispatching', async () => {
    const registry = registryWith(async () => {
      throw new Error('must not run');
    });

    const settled = await executeToolCall(registry, {
      callId: 'call-7',
      name: 'get_time',
      args: {},
    });

    expect(settled.resultState).toBe('failed');
    expect(settled.result).toEqual({ requestedTool: 'get_time' });
    expect(settled.response).toContain('get_time');
  });

  it('rejects prototype-chain names like toString as unknown tools', async () => {
    const registry = registryWith(async () => {
      throw new Error('must not run');
    });

    const settled = await executeToolCall(registry, {
      callId: 'call-8',
      name: 'toString',
      args: {},
    });

    expect(settled).toMatchObject({ resultState: 'failed', result: { requestedTool: 'toString' } });
  });
});
