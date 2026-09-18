// Replays the hand-written adversarial scripts in scripts/attacks/ against
// the agent, in process, and records what happened: the transcript, every
// tool call with its result state, the refund ledger, and the trace ids.
// No assertions, on purpose: today a human judges each script's break
// condition against the log; the eval runner is where that becomes
// machine-checked.
//
//   pnpm attack --script split-refund-two-conversations --runs 3
//   pnpm attack --all --runs 3 --prompt-version 1.1.0
//
// Every run is an independent experiment: fresh demo backend, fresh ledger,
// fresh conversation store. Within a run, all conversations of a script
// share that ledger and backend, which is what the cross-conversation
// scripts depend on. Traces reach Langfuse when it is configured and are
// kept in memory either way; one JSON line per run is appended to
// internal/experiments/attacks.jsonl, which is gitignored.

/* oxlint-disable no-await-in-loop -- turns, conversations and runs are sequential by design */

import { appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { configFromEnv, createAgentService } from '../apps/agent/src/handler.ts';
import type { AgentServiceConfig } from '../apps/agent/src/handler.ts';
import { REPO_ROOT, loadAllScripts, loadScript } from './attack-scripts.ts';
import type { AttackScript } from './attack-scripts.ts';
import {
  DemoBackend,
  COUNTING_STATUSES,
  InMemoryRefundLedger,
  LangfuseExporter,
  formatMoney,
  makeDemoOrders,
} from '../packages/core/src/index.ts';
import type {
  CompletedTrace,
  Currency,
  RefundLedgerRecord,
  ToolResultState,
  TraceExporter,
  TurnOutcome,
} from '../packages/core/src/index.ts';

const DEFAULT_LOG = path.join('internal', 'experiments', 'attacks.jsonl');

// --- Trace collection ------------------------------------------------------------

/** Keeps every completed trace in memory and forwards it downstream (Langfuse) when there is one. */
class CollectingExporter implements TraceExporter {
  readonly traces: CompletedTrace[] = [];

  constructor(private readonly downstream: TraceExporter | undefined) {}

  export(trace: CompletedTrace): void {
    this.traces.push(trace);
    this.downstream?.export(trace);
  }

  flush(): Promise<void> {
    return this.downstream?.flush() ?? Promise.resolve();
  }
}

type ToolCallRecord = {
  callId: string;
  toolName: string;
  args: unknown;
  resultState: ToolResultState | 'undetermined';
};

function toolCallsIn(trace: CompletedTrace): ToolCallRecord[] {
  return trace.spans.flatMap((span) =>
    span.kind === 'tool_execution'
      ? [
          {
            callId: span.callId,
            toolName: span.toolName,
            args: span.args,
            resultState: span.resultState ?? 'undetermined',
          },
        ]
      : [],
  );
}

// --- One run ----------------------------------------------------------------------

type TurnRecord = {
  customer: string;
  outcome: TurnOutcome;
  traceId: string | null;
  toolCalls: ToolCallRecord[];
};

type ConversationRecord = { index: number; conversationId: string; turns: TurnRecord[] };

type RunRecord = {
  at: string;
  script: Omit<AttackScript, 'conversations'>;
  run: number;
  of: number;
  provider: string;
  model: string;
  promptVersion: string;
  promptHash: string | null;
  conversations: ConversationRecord[];
  ledger: RefundLedgerRecord[];
  /** Display-only totals of the records that count toward caps, per order and per customer key. */
  sums: { byOrder: Record<string, string>; byCustomer: Record<string, string> };
};

function sumBy(
  records: RefundLedgerRecord[],
  key: (record: RefundLedgerRecord) => string,
): Record<string, string> {
  const totals = new Map<string, Map<Currency, number>>();
  for (const record of records) {
    if (!COUNTING_STATUSES.has(record.status)) continue;
    const byCurrency = totals.get(key(record)) ?? new Map<Currency, number>();
    byCurrency.set(
      record.currency,
      (byCurrency.get(record.currency) ?? 0) + record.amountMinorUnits,
    );
    totals.set(key(record), byCurrency);
  }
  return Object.fromEntries(
    [...totals].map(([k, byCurrency]) => [
      k,
      [...byCurrency].map(([currency, minor]) => formatMoney(minor, currency)).join(' + '),
    ]),
  );
}

/** "order-1002: $101.00, order-1005: $79.00", or "nothing". */
function describeSums(entries: Record<string, string>): string {
  return (
    Object.entries(entries)
      .map(([k, v]) => `${k}: ${v}`)
      .join(', ') || 'nothing'
  );
}

function describeOutcome(outcome: TurnOutcome): string {
  switch (outcome.type) {
    case 'reply':
      return outcome.message;
    case 'failed':
      return `<turn failed: ${outcome.reason}>`;
    case 'conversation_full':
      return '<conversation full>';
  }
}

function shortHash(hash: string | null): string {
  return hash ? hash.slice(0, 12) : 'n/a';
}

async function runOnce(
  script: AttackScript,
  config: AgentServiceConfig,
  langfuse: TraceExporter | undefined,
  run: number,
  of: number,
): Promise<RunRecord> {
  // Fresh world per run, shared across the run's conversations.
  const backend = new DemoBackend(makeDemoOrders(Date.now()));
  const ledger = new InMemoryRefundLedger();
  const collector = new CollectingExporter(langfuse);
  const service = await createAgentService(config, { backend, ledger, exporter: collector });

  const conversations: ConversationRecord[] = [];
  for (const [index, turns] of script.conversations.entries()) {
    let conversationId: string | undefined;
    const record: ConversationRecord = { index: index + 1, conversationId: '', turns: [] };
    for (const customer of turns) {
      console.log(`  customer › ${customer}`);
      const result = await service.handleNewMessage(customer, conversationId);
      if (result.kind === 'conversation_not_found') {
        throw new Error(`conversation ${conversationId} vanished mid-script`);
      }
      conversationId = result.conversationId;
      record.conversationId = conversationId;
      // The host exports the turn's trace before handleNewMessage resolves.
      const trace = collector.traces.at(-1) ?? null;
      const toolCalls = trace ? toolCallsIn(trace) : [];
      console.log(`  agent    › ${describeOutcome(result.outcome)}`);
      for (const call of toolCalls) {
        console.log(
          `  tool     › ${call.toolName} ${JSON.stringify(call.args)} → ${call.resultState}`,
        );
      }
      record.turns.push({
        customer,
        outcome: result.outcome,
        traceId: trace?.id ?? null,
        toolCalls,
      });
    }
    console.log(`  (conversation ${record.index}: ${record.conversationId})\n`);
    conversations.push(record);
  }
  await service.shutdown();

  const records = await ledger.list();
  const conversationIndex = new Map(conversations.map((c) => [c.conversationId, c.index]));
  console.log(`  ledger (${records.length} record${records.length === 1 ? '' : 's'})`);
  for (const record of records) {
    const amount = formatMoney(record.amountMinorUnits, record.currency);
    console.log(
      `    ${record.status.padEnd(9)} ${record.orderId} ${record.orderItemId} ×${record.quantity} ${amount.padStart(9)}  conv ${conversationIndex.get(record.conversationId) ?? '?'}`,
    );
  }
  const sums = {
    byOrder: sumBy(records, (record) => record.orderId),
    byCustomer: sumBy(records, (record) => record.customerKey.slice(0, 8)),
  };
  console.log(
    `  counting toward caps — by order: ${describeSums(sums.byOrder)}; by customer: ${describeSums(sums.byCustomer)}`,
  );

  const firstTrace = collector.traces[0];
  const { conversations: _conversations, ...scriptMeta } = script;
  return {
    at: new Date().toISOString(),
    script: scriptMeta,
    run,
    of,
    provider: config.provider,
    model: config.model,
    promptVersion: config.promptVersion,
    promptHash: firstTrace?.promptHash ?? null,
    conversations,
    ledger: records,
    sums,
  };
}

// --- CLI ---------------------------------------------------------------------------

function usage(): never {
  console.error(`usage: pnpm attack (--script <name-or-path> ... | --all) [--runs N] [--prompt-version V] [--model M] [--log <path>]

  --script         a file in scripts/attacks/ by name (without .json) or any path; repeatable
  --all            every script in scripts/attacks/, in id order
  --runs           repetitions per script (default 1); prompt guards are stochastic, run several
  --prompt-version overrides KEPT_PROMPT_VERSION for this invocation
  --model          overrides KEPT_MODEL for this invocation
  --log            JSONL file to append one line per run to (default ${DEFAULT_LOG})`);
  process.exit(1);
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      script: { type: 'string', multiple: true, short: 's' },
      all: { type: 'boolean', default: false },
      runs: { type: 'string', default: '1' },
      'prompt-version': { type: 'string' },
      model: { type: 'string' },
      log: { type: 'string', default: DEFAULT_LOG },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  if (values.help || (!values.all && (values.script ?? []).length === 0)) usage();

  const runs = Number(values.runs);
  if (!Number.isInteger(runs) || runs < 1) usage();

  const scripts = values.all
    ? await loadAllScripts()
    : await Promise.all((values.script ?? []).map((name) => loadScript(name)));

  const config: AgentServiceConfig = {
    ...configFromEnv(process.env),
    ...(values['prompt-version'] === undefined ? {} : { promptVersion: values['prompt-version'] }),
    ...(values.model === undefined ? {} : { model: values.model }),
  };
  const langfuse = config.langfuse ? new LangfuseExporter(config.langfuse) : undefined;
  if (!langfuse) {
    console.warn('attack: LANGFUSE_PUBLIC_KEY/SECRET_KEY unset — traces stay in memory only\n');
  }

  const logPath = path.resolve(REPO_ROOT, values.log);
  await mkdir(path.dirname(logPath), { recursive: true });

  const summary: string[] = [];
  for (const script of scripts) {
    for (let run = 1; run <= runs; run++) {
      const header = `${script.id} · ${script.title ?? script.file} · run ${run}/${runs} · prompt ${config.promptVersion} · ${config.model}`;
      console.log(`\n── ${header}`);
      if (script.breakCondition) console.log(`   breaks when: ${script.breakCondition}`);
      if (script.prediction) console.log(`   predicted:   ${script.prediction}\n`);

      const record = await runOnce(script, config, langfuse, run, runs);
      await appendFile(logPath, `${JSON.stringify(record)}\n`);

      const sessionIds = record.conversations.map((c) => c.conversationId).join(', ');
      console.log(`  prompt hash ${shortHash(record.promptHash)} · sessions ${sessionIds}`);
      summary.push(
        `${script.id} run ${run}: ${record.ledger.length} record(s); by order ${JSON.stringify(record.sums.byOrder)}`,
      );
    }
  }

  console.log(
    `\n── summary (${scripts.length} script(s) × ${runs} run(s)); full log: ${path.relative(REPO_ROOT, logPath)}`,
  );
  for (const line of summary) console.log(`  ${line}`);
  if (langfuse && config.langfuse) {
    console.log(`  open ${config.langfuse.baseUrl} and filter by session id to read the traces`);
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
