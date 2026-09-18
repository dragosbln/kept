// The scam-me demo: replays one adversarial script against a running agent
// service over HTTP, the way a storefront widget would, and shows where the
// money went. The transcript prints as it happens; at the end the script
// reads the approval queue back and prints the link to the record that
// landed there, with the caps math the human will see. Nothing runs in
// process: this is the service you would deploy, with its own ledger and
// its own inbox, being asked for a refund it must not hand over on its own.
//
//   pnpm start                        # one terminal; not `pnpm dev`, whose
//                                     # watcher restarts wipe the ledger
//   pnpm demo:scam                    # another terminal; the double dip by default
//   pnpm demo:scam --script sympathy  # any file in scripts/attacks/
//
// Reads the service URL from --url or KEPT_AGENT_URL (default
// http://localhost:$PORT) and the inbox credential from KEPT_INBOX_USER /
// KEPT_INBOX_PASSWORD, all from .env. Every run adds to the service's
// in-memory ledger, so a second run of the same script meets its own
// earlier refunds; restart the service for a clean slate.

/* oxlint-disable no-await-in-loop -- turns and conversations are sequential by design */

import { parseArgs } from 'node:util';
import { formatMoney } from '../packages/core/src/index.ts';
import type {
  CapDecision,
  InboxRefundDetail,
  InboxRefundItem,
  Message,
  TurnOutcome,
} from '../packages/core/src/index.ts';
import { loadScript } from './attack-scripts.ts';

const DEFAULT_SCRIPT = 'double-dip-across-chats';

type ChatResponse = { conversationId: string; outcome: TurnOutcome };

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

async function getJson<T>(url: string, headers: Record<string, string> = {}): Promise<T> {
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`GET ${url} → ${res.status} ${res.statusText}`);
  return (await res.json()) as T;
}

async function chat(
  baseUrl: string,
  message: string,
  conversationId: string | undefined,
): Promise<ChatResponse> {
  const res = await fetch(`${baseUrl}/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ message, ...(conversationId ? { conversationId } : {}) }),
  });
  if (!res.ok) throw new Error(`POST ${baseUrl}/chat → ${res.status}: ${await res.text()}`);
  return (await res.json()) as ChatResponse;
}

/** One row of the caps math, as the inbox shows it. */
function describeCap(cap: CapDecision): string {
  const money = (minor: number): string => formatMoney(minor, cap.currency);
  const priors = cap.contributingRecordIds.length;
  return (
    `${cap.kind.padEnd(12)} cap ${money(cap.capAmountMinorUnits)} · ` +
    `consumed ${money(cap.consumedAmountMinorUnits)} · ` +
    `remaining ${money(cap.remainingBeforeMinorUnits)} · ` +
    `${cap.outcome}${priors === 0 ? '' : ` (${priors} prior)`}`
  );
}

const clip = (text: string, max: number): string =>
  text.length > max ? `${text.slice(0, max)}…` : text;

/** The tool calls and their results, in order, as the transcript records them. */
function toolExchanges(messages: Message[]): string[] {
  const lines: string[] = [];
  for (const part of messages.flatMap((message) => message.parts)) {
    if (part.type === 'tool_call') {
      lines.push(`→ ${part.name} ${JSON.stringify(part.args)}`);
    } else if (part.type === 'tool_call_response') {
      lines.push(`← ${part.status} · ${clip(part.response, 110)}`);
    }
  }
  return lines;
}

function usage(): never {
  console.error(`usage: pnpm demo:scam [--script <name-or-path>] [--url <agent service url>]

  --script  a file in scripts/attacks/ by name (without .json) or any path (default ${DEFAULT_SCRIPT})
  --url     the running agent service (default KEPT_AGENT_URL, then http://localhost:$PORT)`);
  process.exit(1);
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      script: { type: 'string', short: 's', default: DEFAULT_SCRIPT },
      url: { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  if (values.help) usage();

  const baseUrl = (
    values.url ??
    process.env['KEPT_AGENT_URL'] ??
    `http://localhost:${process.env['PORT'] ?? '3100'}`
  ).replace(/\/+$/, '');
  const script = await loadScript(values.script);

  try {
    await getJson(`${baseUrl}/health`);
  } catch {
    console.error(`no agent service answering at ${baseUrl}
  start one with:      pnpm start   (not pnpm dev: its watcher restarts wipe the in-memory ledger)
  or point elsewhere:  pnpm demo:scam --url http://host:port`);
    process.exit(1);
  }

  console.log(`\n── ${script.id} · ${script.title ?? script.file} · against ${baseUrl}`);
  if (script.breakCondition) console.log(`   breaks when: ${script.breakCondition}`);
  if (script.prediction) console.log(`   predicted:   ${script.prediction}`);

  const conversationIds: string[] = [];
  for (const [index, turns] of script.conversations.entries()) {
    console.log(`\n  conversation ${index + 1}`);
    let conversationId: string | undefined;
    for (const customer of turns) {
      console.log(`  customer › ${customer}`);
      const response = await chat(baseUrl, customer, conversationId);
      conversationId = response.conversationId;
      console.log(`  agent    › ${describeOutcome(response.outcome)}`);
    }
    if (conversationId) conversationIds.push(conversationId);
  }

  const user = process.env['KEPT_INBOX_USER'];
  const password = process.env['KEPT_INBOX_PASSWORD'];
  if (!user || !password) {
    console.log(
      `\n  set KEPT_INBOX_USER and KEPT_INBOX_PASSWORD in .env to read the queue back here; the inbox is at ${baseUrl}/inbox\n`,
    );
    return;
  }
  const auth = {
    authorization: `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`,
  };
  const { items } = await getJson<{ items: InboxRefundItem[] }>(
    `${baseUrl}/inbox/refunds/pending`,
    auth,
  );
  const landed = items.filter((item) => conversationIds.includes(item.record.conversationId));

  if (landed.length === 0) {
    console.log(`\n  queue › nothing from this run is waiting for approval`);
    console.log(
      `    the agent never asked the policy engine for more than the caps allow, or the request was denied outright;`,
    );
    console.log(
      `    open ${baseUrl}/inbox for the ledger's view, or try --script <name> for another attack`,
    );
  } else {
    const count = `${landed.length} request${landed.length === 1 ? '' : 's'}`;
    console.log(`\n  queue › ${count} from this run waiting for a human`);
    for (const { record } of landed) {
      const decision = record.decisionRecord;
      const line = record.orderItemId.replace(`${record.orderId}-`, '');
      const reason = 'reason' in decision ? ` (${decision.reason})` : '';
      console.log(
        `    ${record.orderId} · ${line} × ${record.quantity} · ${formatMoney(record.amountMinorUnits, record.currency)} · ${decision.outcome}${reason}`,
      );
      for (const cap of decision.record.perCap) console.log(`      ${describeCap(cap)}`);
      // The tool-level evidence lives on the conversation: a denied double
      // dip shows here as a failed issue_refund, not only in the agent's words.
      const detail = await getJson<InboxRefundDetail>(
        `${baseUrl}/inbox/refunds/${encodeURIComponent(record.id)}`,
        auth,
      );
      const exchanges = toolExchanges(detail.conversation?.messages ?? []);
      if (exchanges.length > 0) {
        console.log(`    what the tools said in that conversation`);
        for (const exchange of exchanges) console.log(`      ${exchange}`);
      }
      console.log(
        `    open ${baseUrl}/inbox#${encodeURIComponent(record.id)}   (user ${user}; the password is in .env)`,
      );
    }
  }
  console.log(
    `\n  every run adds to the service's in-memory ledger; restart it for a clean slate\n`,
  );
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
