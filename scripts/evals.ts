// Runs the eval suite against the agent, in process: the cases in
// packages/evals/cases, three runs each, assertions over the completed
// traces and the ledger, a report and an exit code. This file is the host
// side of the runner: it knows how to compose a service and hands the
// runner a factory, so the sealed package never imports the app (ADR 0001).
//
//   pnpm evals                              # every case, 3 runs each
//   pnpm evals --tag smoke                  # the push subset
//   pnpm evals --case attack-ask-twice --runs 1
//   pnpm evals --toggle stale-kb            # block 4: one matrix job
//   pnpm evals --list
//
// Needs a model key and Postgres with the corpus ingested: the retrieval
// cases need real ranking. KEPT_EVALS_DATABASE_URL points the suite at its
// own knowledge base; without it DATABASE_URL is used. Traces stay in
// memory for the assertions and also reach Langfuse when it is configured,
// which is how a red is opened by session id without re-running.

/* oxlint-disable no-await-in-loop -- cases and runs are sequential by design */

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import {
  configFromEnv,
  createAgentService,
  type AgentServiceConfig,
} from '../apps/agent/src/handler.ts';
import {
  DemoBackend,
  InMemoryAuditLog,
  InMemoryConversationStore,
  InMemoryRefundLedger,
  LangfuseExporter,
  PolicyEngine,
} from '../packages/core/src/index.ts';
import type {
  CompletedTrace,
  IssueRefundParams,
  IssueRefundResponse,
  Order,
  OrderBackend,
  TraceExporter,
} from '../packages/core/src/index.ts';
import {
  FAULT_TOGGLES,
  exitCodeFor,
  formatSuiteReport,
  loadEvalCases,
  loadQuarantine,
  runSuite,
} from '../packages/evals/src/index.ts';
import type {
  AgentFactory,
  BackendFaults,
  FaultToggle,
  RunHandle,
} from '../packages/evals/src/index.ts';

const REPO_ROOT = path.join(import.meta.dirname, '..');

// --- The world, host side ----------------------------------------------------------

/** Keeps every completed trace in memory for the runner and forwards it to Langfuse when there is one. */
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

/**
 * The platform faults a case declares, as a wrapper over the demo backend:
 * an unknown is "the request went out, no answer came back", which is what
 * the tool's third zone must record without deciding on the error type.
 */
class FaultyBackend implements OrderBackend {
  constructor(
    private readonly inner: OrderBackend,
    private readonly faults: BackendFaults,
  ) {}

  findOrder(orderId: string): Promise<Order | null> {
    return this.inner.findOrder(orderId);
  }

  async issueRefund(key: string, params: IssueRefundParams): Promise<IssueRefundResponse> {
    switch (this.faults.issueRefund) {
      case 'unknown':
        return { status: 'unknown', errorType: 'platform_unreachable' };
      case 'failed':
        return { status: 'failed', errorType: '_OTHER' };
      default:
        return this.inner.issueRefund(key, params);
    }
  }
}

/**
 * A fresh world per run: the case's orders and prior refunds, the case
 * clock behind every clock reader, the declared caps in the engine, and a
 * collecting exporter so the runner reads traces off memory.
 */
function createFactory(
  config: AgentServiceConfig,
  langfuse: TraceExporter | undefined,
): AgentFactory {
  return async function factory(world): Promise<RunHandle> {
    const now = (): number => world.clock.now();
    const collector = new CollectingExporter(langfuse);
    const backend = new FaultyBackend(
      new DemoBackend([...world.orders], structuredClone(world.refundedItems), now),
      world.backend,
    );
    const ledger = new InMemoryRefundLedger([...world.priorRefunds], now);
    const policyEngine = new PolicyEngine(world.policy, { now });
    const agent = await createAgentService(
      { ...config, storeId: world.evalCase.storeId, faultToggles: world.faultToggles },
      {
        backend,
        ledger,
        policyEngine,
        exporter: collector,
        store: new InMemoryConversationStore(),
        auditLog: new InMemoryAuditLog(),
        now,
      },
    );
    return { agent, traces: collector.traces, ledger, effectivePolicy: policyEngine.config };
  };
}

// --- CLI ---------------------------------------------------------------------------

function usage(): never {
  console.error(`usage: pnpm evals [--case <id>]... [--tag <tag>]... [--runs N] [--toggle <name>]... [--json <path>] [--list]

  --case, -c   run this case id; repeatable (default: every case)
  --tag, -t    run cases carrying this tag; repeatable, any match ("smoke" is the push subset)
  --runs       repetitions per case (default 3, the stability rule)
  --toggle     a fault toggle to run under; repeatable. One of: ${FAULT_TOGGLES.join(', ')}
  --json       also write the report as JSON to this path
  --list       print the selected cases and exit`);
  process.exit(1);
}

function isFaultToggle(value: string): value is FaultToggle {
  return (FAULT_TOGGLES as readonly string[]).includes(value);
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      case: { type: 'string', multiple: true, short: 'c' },
      tag: { type: 'string', multiple: true, short: 't' },
      runs: { type: 'string', default: '3' },
      toggle: { type: 'string', multiple: true },
      json: { type: 'string' },
      list: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  if (values.help) usage();

  const runs = Number(values.runs);
  if (!Number.isInteger(runs) || runs < 1) usage();

  const faultToggles: FaultToggle[] = [];
  for (const toggle of values.toggle ?? []) {
    if (!isFaultToggle(toggle)) {
      console.error(`evals: unknown toggle "${toggle}"; one of ${FAULT_TOGGLES.join(', ')}`);
      process.exit(1);
    }
    faultToggles.push(toggle);
  }

  const [allCases, quarantine] = await Promise.all([loadEvalCases(), loadQuarantine()]);
  const ids = new Set(values.case ?? []);
  for (const id of ids) {
    if (!allCases.some((evalCase) => evalCase.id === id)) {
      console.error(`evals: no case "${id}"; try --list`);
      process.exit(1);
    }
  }
  const tags = new Set(values.tag ?? []);
  const cases = allCases.filter(
    (evalCase) =>
      (ids.size === 0 || ids.has(evalCase.id)) &&
      (tags.size === 0 || evalCase.tags.some((tag) => tags.has(tag))),
  );
  if (cases.length === 0) {
    console.error('evals: no case matches the selection; try --list');
    process.exit(1);
  }

  if (values.list) {
    for (const evalCase of cases) {
      const quarantined = quarantine.some((entry) => entry.caseId === evalCase.id);
      console.log(
        `${evalCase.id.padEnd(44)} ${evalCase.tags.join(',').padEnd(24)} ${evalCase.title}${quarantined ? '  (quarantined)' : ''}`,
      );
    }
    return;
  }

  let config = configFromEnv(process.env);
  const evalsDatabaseUrl = process.env['KEPT_EVALS_DATABASE_URL']?.trim();
  if (evalsDatabaseUrl) config = { ...config, databaseUrl: evalsDatabaseUrl };
  if (!config.databaseUrl) {
    throw new Error(
      'evals: DATABASE_URL (or KEPT_EVALS_DATABASE_URL) is not set; the retrieval cases need the knowledge base. pnpm stack:db, then pnpm db:migrate && pnpm kb:ingest',
    );
  }
  const langfuse = config.langfuse ? new LangfuseExporter(config.langfuse) : undefined;

  console.log(
    `evals: ${cases.length} case(s) × ${runs} run(s) · ${config.provider} ${config.model} · prompt ${config.promptVersion} · toggles ${faultToggles.length ? faultToggles.join(', ') : 'none'}${langfuse ? '' : ' · traces in memory only'}\n`,
  );

  const report = await runSuite(cases, quarantine, createFactory(config, langfuse), {
    runs,
    faultToggles,
  });
  await langfuse?.flush();

  console.log(formatSuiteReport(report, cases));

  if (values.json) {
    const file = path.resolve(REPO_ROOT, values.json);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(
      file,
      JSON.stringify(
        {
          provider: config.provider,
          model: config.model,
          promptVersion: config.promptVersion,
          ...report,
        },
        null,
        2,
      ),
    );
    console.log(`report written to ${path.relative(REPO_ROOT, file)}`);
  }

  process.exitCode = exitCodeFor(report);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
