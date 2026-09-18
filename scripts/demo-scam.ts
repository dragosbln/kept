// The scam-me demo: replays one adversarial script against a running agent
// service over HTTP, the way a storefront widget would, and shows where the
// money went. The transcript prints as it happens, one section per
// conversation; at the end the script reads the approval queue back and
// prints the caps math the human will see and the link to the record, which
// is the point of the whole exercise. Nothing runs in process: this is the
// service you would deploy, with its own ledger and its own inbox, being
// asked for a refund it must not hand over on its own.
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
// earlier refunds; restart the service for a clean slate. Colour is plain
// ANSI, no dependency, and off when stdout is not a terminal or NO_COLOR is
// set.

/* oxlint-disable no-await-in-loop -- turns and conversations are sequential by design */

import { parseArgs } from 'node:util';
import { formatMoney } from '../packages/core/src/index.ts';
import type {
  CapDecision,
  InboxRefundDetail,
  InboxRefundItem,
  Message,
  RefundLedgerRecord,
  TurnOutcome,
} from '../packages/core/src/index.ts';
import { loadScript } from './attack-scripts.ts';
import type { AttackScript } from './attack-scripts.ts';

const DEFAULT_SCRIPT = 'double-dip-across-chats';

// --- Terminal styling ---------------------------------------------------------

const COLOR =
  Boolean(process.stdout.isTTY) && !process.env['NO_COLOR'] && process.env['FORCE_COLOR'] !== '0';

type Paint = (text: string) => string;

const paint =
  (open: number, close: number): Paint =>
  (text) =>
    COLOR ? `\u001b[${open}m${text}\u001b[${close}m` : text;

const bold = paint(1, 22);
const dim = paint(2, 22);
const underline = paint(4, 24);
const red = paint(31, 39);
const green = paint(32, 39);
const yellow = paint(33, 39);
const cyan = paint(36, 39);
const plain: Paint = (text) => text;

const WIDTH = 78;
const INDENT = '  ';
const LABEL = 14;

/** A ruled section title: `━━━ Title ━━━━━━…` to the terminal width. */
function section(title: string): void {
  const fill = Math.max(3, WIDTH - title.length - 5);
  console.log(`\n${dim('━━━')} ${bold(title)} ${dim('━'.repeat(fill))}\n`);
}

/** `label   value`, the label dimmed and padded to a fixed column, the value wrapped under itself. */
function field(label: string, value: string): void {
  const [first = '', ...rest] = wrap(value, TEXT_WIDTH);
  console.log(`${INDENT}${dim(label.padEnd(LABEL))}${first}`);
  for (const line of rest) console.log(`${INDENT}${' '.repeat(LABEL)}${line}`);
}

/** Text width for wrapped speech: the terminal minus indent and label; generous when piped. */
const TEXT_WIDTH = Math.max(40, (process.stdout.columns ?? 100) - INDENT.length - LABEL);

/** Word-wraps each paragraph of `text` to `width` columns; blank paragraphs stay blank. */
function wrap(text: string, width: number): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split('\n')) {
    if (paragraph.trim() === '') {
      lines.push('');
      continue;
    }
    let current = '';
    for (const word of paragraph.trim().split(/\s+/)) {
      if (current !== '' && current.length + 1 + word.length > width) {
        lines.push(current);
        current = word;
      } else {
        current = current === '' ? word : `${current} ${word}`;
      }
    }
    lines.push(current);
  }
  return lines;
}

/** A speaker line with a hanging indent: every wrapped line sits under the label, blank lines stay bare. */
function speak(label: string, text: string, paintLabel: Paint, paintText: Paint = plain): void {
  const [first = '', ...rest] = wrap(text, TEXT_WIDTH);
  console.log(`${INDENT}${paintLabel(bold(label.padEnd(LABEL)))}${paintText(first)}`);
  for (const line of rest) {
    console.log(line === '' ? '' : `${INDENT}${' '.repeat(LABEL)}${paintText(line)}`);
  }
}

const verdictPaint = (outcome: string): Paint =>
  outcome === 'allow' ? green : outcome === 'deny' ? red : yellow;

const statusPaint = (status: string): Paint =>
  status === 'ok' ? green : status === 'failed' ? red : yellow;

const clip = (text: string, max: number): string =>
  text.length > max ? `${text.slice(0, max)}…` : text;

// --- HTTP ----------------------------------------------------------------------

type ChatResponse = { conversationId: string; outcome: TurnOutcome };

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

// --- Rendering ------------------------------------------------------------------

function printHeader(script: AttackScript, baseUrl: string): void {
  console.log(`\n${INDENT}${bold('Kept · scam-me demo')}`);
  console.log(`${INDENT}${bold(script.title ?? script.file)} ${dim(`(${script.id})`)}`);
  field('against', baseUrl);
  if (script.breakCondition) field('breaks when', script.breakCondition);
  if (script.prediction) field('predicted', script.prediction);
}

function printAgentTurn(outcome: TurnOutcome): void {
  switch (outcome.type) {
    case 'reply':
      speak('Agent', outcome.message, green);
      return;
    case 'failed':
      speak('Agent', `turn failed: ${outcome.reason}`, red, red);
      return;
    case 'conversation_full':
      speak('Agent', 'conversation full', red, red);
  }
}

/** The caps math as an aligned table: one row per cap, verdict coloured, priors noted. */
function printCapsTable(caps: CapDecision[]): void {
  const rows = caps.map((cap) => {
    const money = (minor: number): string => formatMoney(minor, cap.currency);
    return {
      kind: cap.kind,
      limit: money(cap.capAmountMinorUnits),
      consumed: money(cap.consumedAmountMinorUnits),
      remaining: money(cap.remainingBeforeMinorUnits),
      verdict: cap.outcome,
      priors: cap.contributingRecordIds.length,
    };
  });
  const head = { kind: 'cap', limit: 'limit', consumed: 'consumed', remaining: 'remaining' };
  const width = (key: keyof typeof head): number =>
    Math.max(head[key].length, ...rows.map((row) => row[key].length));
  const cell = (text: string, key: keyof typeof head): string =>
    key === 'kind' ? text.padEnd(width(key)) : text.padStart(width(key));
  const line = (row: typeof head): string =>
    [
      cell(row.kind, 'kind'),
      cell(row.limit, 'limit'),
      cell(row.consumed, 'consumed'),
      cell(row.remaining, 'remaining'),
    ].join('   ');

  const verdictWidth = Math.max(...rows.map((row) => row.verdict.length));
  console.log(`${INDENT}${dim(`${line(head)}   verdict`)}`);
  for (const row of rows) {
    const tint = verdictPaint(row.verdict);
    const verdict =
      row.priors === 0
        ? tint(row.verdict)
        : `${tint(row.verdict.padEnd(verdictWidth))}${dim(`  · ${row.priors} prior`)}`;
    console.log(`${INDENT}${line(row)}   ${verdict}`);
  }
}

/** The tool calls and their results, in order, as the transcript records them. */
function printToolExchanges(messages: Message[]): void {
  const parts = messages.flatMap((message) => message.parts);
  const calls = parts.filter((part) => part.type === 'tool_call');
  if (calls.length === 0) return;
  const nameWidth = Math.max(...calls.map((call) => call.name.length), 'failed'.length);
  console.log(`\n${INDENT}${dim('tool calls in that conversation')}`);
  for (const part of parts) {
    if (part.type === 'tool_call') {
      console.log(
        `${INDENT}${dim('→')} ${bold(part.name.padEnd(nameWidth))}  ${dim(JSON.stringify(part.args))}`,
      );
    } else if (part.type === 'tool_call_response') {
      const status = statusPaint(part.status)(part.status.padEnd(nameWidth));
      console.log(`${INDENT}${dim('←')} ${status}  ${clip(part.response, 120)}`);
    }
  }
}

function printRecord(record: RefundLedgerRecord): void {
  const decision = record.decisionRecord;
  const line = record.orderItemId.replace(`${record.orderId}-`, '');
  const amount = formatMoney(record.amountMinorUnits, record.currency);
  const reason = 'reason' in decision ? dim(` · ${decision.reason}`) : '';
  console.log(`${INDENT}${bold(`${record.orderId} · ${line} × ${record.quantity} · ${amount}`)}`);
  field('decision', `${verdictPaint(decision.outcome)(decision.outcome)}${reason}`);
  console.log('');
  printCapsTable(decision.record.perCap);
}

function printInboxLinks(baseUrl: string, user: string | undefined, recordIds: string[]): void {
  section('Open the approval inbox');
  const targets =
    recordIds.length === 0
      ? [`${baseUrl}/inbox`]
      : recordIds.map((id) => `${baseUrl}/inbox#${encodeURIComponent(id)}`);
  for (const url of targets) console.log(`${INDENT}${cyan('▶')}  ${bold(underline(cyan(url)))}`);
  console.log(
    `${INDENT}   ${dim(
      user
        ? `sign in as ${user} · the password is KEPT_INBOX_PASSWORD in .env`
        : 'the credential is KEPT_INBOX_USER / KEPT_INBOX_PASSWORD in .env',
    )}`,
  );
  console.log(
    `\n${INDENT}${dim("Every run adds to the service's in-memory ledger; restart it for a clean slate.")}\n`,
  );
}

// --- CLI -------------------------------------------------------------------------

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
    console.error(`${red(`no agent service answering at ${baseUrl}`)}
  start one with:      pnpm start   (not pnpm dev: its watcher restarts wipe the in-memory ledger)
  or point elsewhere:  pnpm demo:scam --url http://host:port`);
    process.exit(1);
  }

  printHeader(script, baseUrl);

  const conversationIds: string[] = [];
  const total = script.conversations.length;
  for (const [index, turns] of script.conversations.entries()) {
    const fresh = index === 0 ? '' : ' · a new chat, the agent remembers nothing of the last one';
    section(`Conversation ${index + 1} of ${total}${fresh}`);
    let conversationId: string | undefined;
    for (const [turnIndex, customer] of turns.entries()) {
      if (turnIndex > 0) console.log('');
      console.log(`${INDENT}${dim(`turn ${turnIndex + 1}`)}`);
      speak('Customer', customer, cyan);
      const response = await chat(baseUrl, customer, conversationId);
      conversationId = response.conversationId;
      printAgentTurn(response.outcome);
    }
    if (conversationId) conversationIds.push(conversationId);
  }

  section('What the trust layer did');

  const user = process.env['KEPT_INBOX_USER'];
  const password = process.env['KEPT_INBOX_PASSWORD'];
  if (!user || !password) {
    console.log(
      `${INDENT}${yellow('The queue could not be read back:')} set KEPT_INBOX_USER and KEPT_INBOX_PASSWORD in .env.`,
    );
    printInboxLinks(baseUrl, undefined, []);
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
    console.log(`${INDENT}${bold('Nothing from this run is waiting for a human.')}`);
    console.log(
      `${INDENT}${dim('Either the agent never asked the policy engine for more than the caps allow, or the request was')}`,
    );
    console.log(
      `${INDENT}${dim('denied outright. The inbox shows the ledger either way; --script <name> tries another attack.')}`,
    );
  } else {
    const count = landed.length === 1 ? 'One refund request' : `${landed.length} refund requests`;
    console.log(
      `${INDENT}${bold(`${count} from this run ${landed.length === 1 ? 'is' : 'are'} waiting for a human.`)}\n`,
    );
    for (const [index, { record }] of landed.entries()) {
      if (index > 0) console.log('');
      printRecord(record);
      // The tool-level evidence lives on the conversation: a denied double
      // dip shows here as a failed issue_refund, not only in the agent's words.
      const detail = await getJson<InboxRefundDetail>(
        `${baseUrl}/inbox/refunds/${encodeURIComponent(record.id)}`,
        auth,
      );
      printToolExchanges(detail.conversation?.messages ?? []);
    }
  }

  printInboxLinks(
    baseUrl,
    user,
    landed.map(({ record }) => record.id),
  );
}

main().catch((error: unknown) => {
  console.error(red(error instanceof Error ? error.message : String(error)));
  process.exit(1);
});
