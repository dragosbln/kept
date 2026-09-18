// The host side of a turn — everything the loop's preconditions assign to
// the caller (journal, state machine preconditions): hold the conversation
// lock, hand in deps, persist what runTurn returns, and end + export the
// trace after the loop is done. The loop never speaks HTTP and never ends
// the trace; this file owns both boundaries.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  AnthropicModelClient,
  CodePromptManager,
  DEFAULT_POLICY_CONFIG,
  hashPolicyConfig,
  parsePolicyConfig,
  DemoBackend,
  InMemoryAuditLog,
  InMemoryConversationStore,
  InMemoryRefundLedger,
  LangfuseExporter,
  OPENAI_REASONING_EFFORTS,
  OpenAIModelClient,
  PolicyEngine,
  Trace,
  InboxService,
  createToolRegistry,
  makeDemoOrders,
  runTurn,
  toModelToolRegistry,
} from '@kept-hq/core';
import type {
  AuditLog,
  BackendKind,
  ConversationStore,
  InboxActions,
  Message,
  ModelClient,
  ModelClientConfig,
  OpenAIReasoningEffort,
  OrderBackend,
  PolicyEngineConfig,
  PromptData,
  RefundLedger,
  ToolRegistry,
  TraceExporter,
  TurnOutcome,
} from '@kept-hq/core';

// --- Conversation lock ------------------------------------------------------
// In-process, per-conversation FIFO: one turn at a time per conversation
// (the loop's single-flight precondition). No TTL — single process, and a
// turn always settles (model timeouts + tool timeouts bound it). v0 scope.

class ConversationLocks {
  private tails = new Map<string, Promise<void>>();

  async run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const prev = this.tails.get(key) ?? Promise.resolve();
    const next = prev.then(() => task());
    const tail = next.then(
      () => undefined,
      () => undefined,
    );
    this.tails.set(key, tail);
    try {
      return await next;
    } finally {
      if (this.tails.get(key) === tail) {
        this.tails.delete(key);
      }
    }
  }
}

// --- Configuration ----------------------------------------------------------

export type Provider = 'anthropic' | 'openai';

export type AgentServiceConfig = {
  provider: Provider;
  model: string;
  maxTokens: number;
  promptVersion: string;
  backendKind: BackendKind;
  apiKey: string;
  /** OpenAI only: the `reasoning_effort` sent on every call; absent means the field is not sent. */
  reasoningEffort?: OpenAIReasoningEffort;
  /** The caps file named by KEPT_POLICY_CONFIG, parsed and hashed; absent means the built-in defaults. */
  policy?: { source: string; config: PolicyEngineConfig; hash: string };
  langfuse?: { baseUrl: string; publicKey: string; secretKey: string };
};

/**
 * KEPT_POLICY_CONFIG names a JSON file with the caps a merchant wants; the
 * shape is the policy engine's own schema (see config/README.md). Read and
 * validated once here, so a bad file stops the boot instead of failing the
 * first refund. Relative paths resolve from where pnpm was invoked
 * (INIT_CWD, the repo root under `pnpm start`), else from the cwd.
 */
function policyFromEnv(env: NodeJS.ProcessEnv): AgentServiceConfig['policy'] {
  const raw = env['KEPT_POLICY_CONFIG']?.trim();
  if (!raw) return undefined;
  const source = path.resolve(env['INIT_CWD'] ?? process.cwd(), raw);

  let text: string;
  try {
    text = readFileSync(source, 'utf8');
  } catch {
    throw new Error(`KEPT_POLICY_CONFIG: no file at ${source}`);
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`KEPT_POLICY_CONFIG: ${source} is not valid JSON: ${detail}`, {
      cause: error,
    });
  }
  try {
    const config = parsePolicyConfig(json);
    return { source, config, hash: hashPolicyConfig(config) };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `KEPT_POLICY_CONFIG: ${source} does not match the policy config schema: ${detail}`,
      { cause: error },
    );
  }
}

const PROVIDERS: readonly Provider[] = ['anthropic', 'openai'];

const API_KEY_VAR: Record<Provider, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
};

type ProviderDefaults = {
  model: string;
  maxTokens: number;
  reasoningEffort?: OpenAIReasoningEffort;
};

/**
 * One set of defaults per provider, so pasting a single key into .env is the
 * whole setup. Both are the cheap tier of their provider: calling the tools
 * and relaying their results is all the prompt asks of the model, the trust
 * layer decides. Luna over gpt-4o-mini at near-equal price because it
 * attempts the refund the demo needs caught every time (3 of 3 against 1 of
 * 3). Reasoning is off: Chat Completions refuses function tools on the 5.6
 * models otherwise, and a model without reasoning rejects the field, so
 * KEPT_OPENAI_REASONING_EFFORT is emptied when switching to one.
 */
export const PROVIDER_DEFAULTS: Record<Provider, ProviderDefaults> = {
  anthropic: { model: 'claude-haiku-4-5', maxTokens: 1024 },
  openai: { model: 'gpt-5.6-luna', maxTokens: 1024, reasoningEffort: 'none' },
};

const isProvider = (value: string): value is Provider => (PROVIDERS as string[]).includes(value);

/**
 * KEPT_OPENAI_REASONING_EFFORT: unset means the provider default, an empty
 * value means "send no such field" (non-reasoning models reject it), anything
 * else must be a value the endpoint knows.
 */
function reasoningEffortFromEnv(
  env: NodeJS.ProcessEnv,
  defaults: ProviderDefaults,
): OpenAIReasoningEffort | undefined {
  const raw = env['KEPT_OPENAI_REASONING_EFFORT'];
  if (raw === undefined) return defaults.reasoningEffort;
  const value = raw.trim();
  if (value === '') return undefined;
  if (!(OPENAI_REASONING_EFFORTS as readonly string[]).includes(value)) {
    throw new Error(
      `KEPT_OPENAI_REASONING_EFFORT must be one of ${OPENAI_REASONING_EFFORTS.join(', ')}, or empty to send none; got "${value}"`,
    );
  }
  return value as OpenAIReasoningEffort;
}

/**
 * KEPT_PROVIDER when set; otherwise the provider whose key is present. Two
 * keys and no KEPT_PROVIDER is a refusal, not a guess: which model answers
 * customers is not something to infer from the order of lines in a file.
 */
function providerFromEnv(env: NodeJS.ProcessEnv): Provider {
  const explicit = env['KEPT_PROVIDER']?.trim();
  if (explicit) {
    if (!isProvider(explicit)) {
      throw new Error(`KEPT_PROVIDER must be one of ${PROVIDERS.join(', ')}; got "${explicit}"`);
    }
    return explicit;
  }
  const withKey = PROVIDERS.filter((provider) => env[API_KEY_VAR[provider]]);
  if (withKey.length === 1) return withKey[0]!;
  if (withKey.length === 0) {
    throw new Error(
      'no model key — set ANTHROPIC_API_KEY or OPENAI_API_KEY in .env; the agent service cannot call the model',
    );
  }
  throw new Error(
    'both ANTHROPIC_API_KEY and OPENAI_API_KEY are set — choose with KEPT_PROVIDER=anthropic or KEPT_PROVIDER=openai',
  );
}

/** Reads service config from env; throws at boot (never per request). */
export function configFromEnv(env: NodeJS.ProcessEnv): AgentServiceConfig {
  const provider = providerFromEnv(env);
  const backendKind = env['KEPT_BACKEND'] === 'medusa' ? 'medusa' : 'demo';

  const apiKey = env[API_KEY_VAR[provider]];
  if (!apiKey) {
    throw new Error(
      `${API_KEY_VAR[provider]} is not set — KEPT_PROVIDER=${provider} needs it to call the model`,
    );
  }

  const langfusePublicKey = env['LANGFUSE_PUBLIC_KEY'];
  const langfuseSecretKey = env['LANGFUSE_SECRET_KEY'];
  const langfuseBaseUrl =
    env['LANGFUSE_BASE_URL'] ?? `http://localhost:${env['LANGFUSE_PORT'] ?? '3030'}`;

  const defaults = PROVIDER_DEFAULTS[provider];
  const reasoningEffort = provider === 'openai' ? reasoningEffortFromEnv(env, defaults) : undefined;
  const policy = policyFromEnv(env);
  return {
    provider,
    model: env['KEPT_MODEL'] ?? defaults.model,
    maxTokens: Number(env['KEPT_MAX_TOKENS'] ?? defaults.maxTokens),
    promptVersion: env['KEPT_PROMPT_VERSION'] ?? '1.0.0',
    backendKind,
    apiKey,
    ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
    ...(policy === undefined ? {} : { policy }),
    ...(langfusePublicKey && langfuseSecretKey
      ? {
          langfuse: {
            baseUrl: langfuseBaseUrl,
            publicKey: langfusePublicKey,
            secretKey: langfuseSecretKey,
          },
        }
      : {}),
  };
}

function getBackend(backendKind: BackendKind): OrderBackend {
  switch (backendKind) {
    case 'demo':
      // Seed relative to boot time so order ages read naturally in the widget.
      return new DemoBackend(makeDemoOrders(Date.now()));
    case 'medusa':
      throw new Error('Medusa backend arrives in week 3');
  }
}

function buildModelClient(
  config: AgentServiceConfig,
  promptData: PromptData,
  registry: ToolRegistry,
): ModelClient {
  const clientConfig: ModelClientConfig = {
    provider: config.provider,
    model: config.model,
    maxTokens: config.maxTokens,
    promptData,
    toolRegistry: toModelToolRegistry(registry),
  };
  return config.provider === 'anthropic'
    ? new AnthropicModelClient(clientConfig, config.apiKey)
    : new OpenAIModelClient(
        clientConfig,
        config.apiKey,
        undefined,
        config.reasoningEffort === undefined ? {} : { reasoningEffort: config.reasoningEffort },
      );
}

// --- The service ------------------------------------------------------------

export type HandleMessageResult =
  { kind: 'ok'; conversationId: string; outcome: TurnOutcome } | { kind: 'conversation_not_found' };

export type AgentService = {
  handleNewMessage(message: string, conversationId?: string): Promise<HandleMessageResult>;
  /** The approval inbox over this process's ledger, store and backend. */
  inbox: InboxActions;
  /** Drain pending trace exports; call before process exit. */
  shutdown(): Promise<void>;
};

/**
 * What a customer hears once a human has taken the conversation over. The
 * model is not called: the turn is recorded in the history so the human
 * sees it, and traced so the conversation stays one trace.
 */
export const HANDOFF_REPLY =
  'A member of our support team has taken over this conversation and will follow up with you directly. Nothing more is needed from you here.';

/**
 * Replacements for what the service would otherwise build from config. The
 * attack driver injects its own ledger (to read it back after a run) and its
 * own exporter (to keep traces in memory beside Langfuse); tests inject a
 * backend. Production passes nothing.
 */
export type AgentServiceDeps = {
  backend?: OrderBackend;
  ledger?: RefundLedger;
  store?: ConversationStore;
  auditLog?: AuditLog;
  /** The attack driver and the eval runner pass an engine with their own config or clock. */
  policyEngine?: PolicyEngine;
  exporter?: TraceExporter;
};

export async function createAgentService(
  config: AgentServiceConfig,
  deps: AgentServiceDeps = {},
): Promise<AgentService> {
  const promptData = await new CodePromptManager().getVersionedPromptData(
    'main-agent',
    config.promptVersion,
  );
  const backend = deps.backend ?? getBackend(config.backendKind);
  // One ledger per process, shared by every conversation: per-customer and
  // per-day caps, and the cross-conversation attacks, all depend on that.
  const ledger = deps.ledger ?? new InMemoryRefundLedger();
  // One config per process, from the caps file when KEPT_POLICY_CONFIG names
  // one and the built-in defaults otherwise; validated at boot, its hash
  // stamped on every trace and every decision.
  const policyEngine =
    deps.policyEngine ?? new PolicyEngine(config.policy?.config ?? DEFAULT_POLICY_CONFIG);
  const registry = createToolRegistry(backend, ledger, policyEngine);
  const modelClient = buildModelClient(config, promptData, registry);
  const store = deps.store ?? new InMemoryConversationStore();
  const auditLog = deps.auditLog ?? new InMemoryAuditLog();
  const inbox = new InboxService({ ledger, backend, store, audit: auditLog });
  const locks = new ConversationLocks();

  const exporter: TraceExporter | undefined =
    deps.exporter ?? (config.langfuse ? new LangfuseExporter(config.langfuse) : undefined);
  if (!exporter) {
    console.warn('agent service: LANGFUSE_PUBLIC_KEY/SECRET_KEY unset — traces stay local');
  }

  async function handleNewMessage(
    message: string,
    conversationId?: string,
  ): Promise<HandleMessageResult> {
    // Resolve the conversation's identity before taking its lock; an unknown
    // id from the widget is customer input, not a crash.
    let id: string;
    if (conversationId === undefined) {
      id = (await store.createNewConversation()).id;
    } else if (await store.findConversation(conversationId)) {
      id = conversationId;
    } else {
      return { kind: 'conversation_not_found' };
    }

    return locks.run(id, async () => {
      // Re-read inside the lock: a queued turn must see its predecessor's writes.
      const conversation = await store.findConversation(id);
      if (!conversation) return { kind: 'conversation_not_found' };

      const trace = new Trace({
        sessionId: conversation.id,
        providerName: config.provider,
        promptName: promptData.name,
        promptVersion: promptData.version,
        promptHash: promptData.hash,
        policyConfigHash: policyEngine.configHash,
        backendKind: config.backendKind,
      });

      // Taken over: the customer's message is kept for the human, the
      // deferral is the reply, the model is never asked.
      if (conversation.takeOver) {
        const turn = trace.startTurnSpan(null, { customerInput: message });
        const outcome: TurnOutcome = { type: 'reply', message: HANDOFF_REPLY };
        const updatedHistory: Message[] = [
          ...conversation.messages,
          { role: 'user', parts: [{ type: 'text', content: message }] },
          { role: 'assistant', parts: [{ type: 'text', content: HANDOFF_REPLY }] },
        ];
        await store.updateConversationHistory(conversation.id, updatedHistory);
        turn.end({ outcome });
        exporter?.export(trace.end());
        return { kind: 'ok', conversationId: conversation.id, outcome };
      }

      try {
        const { outcome, updatedHistory } = await runTurn({
          history: conversation.messages,
          message,
          modelClient,
          tools: registry,
          conversationId: conversation.id,
          trace,
        });

        await store.updateConversationHistory(conversation.id, updatedHistory);

        return { kind: 'ok', conversationId: conversation.id, outcome };
      } finally {
        // Host obligations, unconditionally: freeze the trace, ship it.
        exporter?.export(trace.end());
      }
    });
  }

  return {
    handleNewMessage,
    inbox,
    shutdown: () => exporter?.flush() ?? Promise.resolve(),
  };
}
