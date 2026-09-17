import { z } from 'zod';
import type { ToolResultState } from '../messages.js';
import type { PolicyDecisionSpan } from '../tracing/span.js';
import type { StartPolicyDecisionPayload } from '../tracing/types.js';

export type ToolName = 'lookup_order' | 'issue_refund';

export type ToolResult = {
  resultState: ToolResultState;
  result: unknown;
  response: string;
};

export type ToolExecuteContext = {
  callId: string;
  /**
   * Fires when the executor gives up on the call (timeout). A tool that can
   * stop in-flight work should honour it; the executor settles the call as
   * `unknown` either way, because whether the work happened is exactly what
   * it no longer knows.
   */
  signal: AbortSignal;
  /**
   * The conversation this call belongs to: the identity a write tool stamps
   * on its ledger record. Carried by the loop untouched from the host.
   */
  conversationId: string;
  /**
   * Hash of the prompt the model was running when it asked for this call,
   * taken from the model config, so a record can say which prompt decided it.
   */
  promptHash: string;
  /**
   * Opens a policy_decision span under this call's tool_execution span. A
   * write tool opens exactly one per consultation of the policy engine,
   * before the ledger's atomic operation, and ends it on every path. The
   * loop wires it; a host or test that builds a context by hand supplies
   * one on a scratch trace.
   */
  startPolicyDecisionSpan: (payload: StartPolicyDecisionPayload) => PolicyDecisionSpan;
};

export type ToolDefinition<TSchema extends z.ZodType> = {
  description: string;
  inputSchema: TSchema;
  execute: (input: z.infer<TSchema>, ctx: ToolExecuteContext) => Promise<ToolResult>;
};

/**
 * A registry entry with its schema type erased. `any` rather than `z.ZodType`
 * on purpose: with the concrete schema gone, `execute` would have to accept
 * `unknown`, and no real tool does. The executor restores the link at run
 * time by parsing the input with the entry's own schema before calling it.
 */
export type AnyToolDefinition = ToolDefinition<any>;

export type ToolRegistry = { [key in ToolName]: AnyToolDefinition };
