// The host side of a turn — everything the loop's preconditions assign to
// the caller (journal, state machine preconditions): hold the conversation
// lock, hand in deps, persist what runTurn returns, and end + export the
// trace after the loop is done. The loop never speaks HTTP and never ends
// the trace; this file owns both boundaries.

import {
  AnthropicModelClient,
  CodePromptManager,
  DEFAULT_POLICY_CONFIG,
  DemoBackend,
  InMemoryAuditLog,
  InMemoryConversationStore,
  InMemoryRefundLedger,
  LangfuseExporter,
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
  OrderBackend,
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

export type AgentServiceConfig = {
  provider: 'anthropic' | 'openai';
  model: string;
  maxTokens: number;
  promptVersion: string;
  backendKind: BackendKind;
  apiKey: string;
  langfuse?: { baseUrl: string; publicKey: string; secretKey: string };
};

/** Reads service config from env; throws at boot (never per request). */
export function configFromEnv(env: NodeJS.ProcessEnv): AgentServiceConfig {
  const provider = env['KEPT_PROVIDER'] === 'openai' ? 'openai' : 'anthropic';
  const backendKind = env['KEPT_BACKEND'] === 'medusa' ? 'medusa' : 'demo';

  const apiKeyVar = provider === 'anthropic' ? 'ANTHROPIC_API_KEY' : 'OPENAI_API_KEY';
  const apiKey = env[apiKeyVar];
  if (!apiKey) {
    throw new Error(`${apiKeyVar} is not set — the agent service cannot call the model`);
  }

  const langfusePublicKey = env['LANGFUSE_PUBLIC_KEY'];
  const langfuseSecretKey = env['LANGFUSE_SECRET_KEY'];
  const langfuseBaseUrl =
    env['LANGFUSE_BASE_URL'] ?? `http://localhost:${env['LANGFUSE_PORT'] ?? '3030'}`;

  return {
    provider,
    model: env['KEPT_MODEL'] ?? 'claude-sonnet-5',
    maxTokens: Number(env['KEPT_MAX_TOKENS'] ?? 1024),
    promptVersion: env['KEPT_PROMPT_VERSION'] ?? '1.0.0',
    backendKind,
    apiKey,
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
    : new OpenAIModelClient(clientConfig, config.apiKey);
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
  // One config per process, validated here at boot; its hash is stamped on
  // every trace and every decision. A config file arrives with the admin.
  const policyEngine = deps.policyEngine ?? new PolicyEngine(DEFAULT_POLICY_CONFIG);
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
