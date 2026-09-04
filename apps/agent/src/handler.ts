// The host side of a turn — everything the loop's preconditions assign to
// the caller (journal, state machine preconditions): hold the conversation
// lock, hand in deps, persist what runTurn returns, and end + export the
// trace after the loop is done. The loop never speaks HTTP and never ends
// the trace; this file owns both boundaries.

import {
  AnthropicModelClient,
  CodePromptManager,
  DemoBackend,
  InMemoryConversationStore,
  LangfuseExporter,
  OpenAIModelClient,
  Trace,
  createToolRegistry,
  makeDemoOrders,
  runTurn,
  toModelToolRegistry,
} from '@kept-hq/core';
import type {
  BackendKind,
  ModelClient,
  ModelClientConfig,
  OrderBackend,
  PromptData,
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
  /** Drain pending trace exports; call before process exit. */
  shutdown(): Promise<void>;
};

export async function createAgentService(config: AgentServiceConfig): Promise<AgentService> {
  const promptData = await new CodePromptManager().getVersionedPromptData(
    'main-agent',
    config.promptVersion,
  );
  const registry = createToolRegistry(getBackend(config.backendKind));
  const modelClient = buildModelClient(config, promptData, registry);
  const store = new InMemoryConversationStore();
  const locks = new ConversationLocks();

  const exporter: TraceExporter | undefined = config.langfuse
    ? new LangfuseExporter(config.langfuse)
    : undefined;
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
        backendKind: config.backendKind,
      });

      try {
        const { outcome, updatedHistory } = await runTurn({
          history: conversation.messages,
          message,
          modelClient,
          tools: registry,
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
    shutdown: () => exporter?.flush() ?? Promise.resolve(),
  };
}
