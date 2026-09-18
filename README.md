# Kept

Open-source, self-hostable post-purchase support agent for e-commerce —
answers "where is my order", executes returns and refunds — where the
trust layer is the product: approval queue, caps that compose,
idempotency, audit trail, versioned prompts, CI evals, tracing, and
fault-injection toggles.

Medusa-first adapter over a platform-agnostic core. TypeScript. MIT.

> Status: pre-v0, under active construction. The trust layer is built and
> demonstrable: the agent loop with its tool layer, the policy engine, the
> idempotent refund ledger, the approval inbox, tracing, and the chat
> widget. Retrieval, the eval runner, the fault-toggle matrix and the
> Medusa adapter are next. Nothing here is stable yet.

## What is built today

- **Agent loop** on the provider SDKs directly, no agent framework. Two
  model clients, Anthropic and OpenAI, behind one interface; a
  hand-rolled tool loop with explicit stop conditions.
- **Tool layer whose results are ok, failed, or unknown.** Unknown is the
  state after a write whose outcome the backend never confirmed. The tool
  tells the model not to retry, and nothing does, until a human
  reconciles it.
- **Policy engine with composed caps.** Per refund, per order, per
  customer over a trailing 30 days, and per store over a trailing
  24 hours. Every cap is evaluated on every request, inside the same
  atomic ledger operation that records it, so two requests cannot both
  pass on the same empty snapshot. Crossing a cap does not deny: it
  parks the refund for a human. Deny is reserved for eligibility, such
  as an item that was never delivered or a line already refunded.
- **Idempotency.** Every refund write carries a key minted by the
  ledger. Same key and same parameters replay the recorded outcome; same
  key and different parameters is a conflict; a replay is something only
  a human's reconcile action may trigger.
- **Approval inbox.** The pending queue with the caps math behind each
  decision, the transcript with every tool call, a reconciliation list
  for writes that went unknown, an append-only audit trail of human
  actions, and four actions: approve, deny, reconcile, take over. Behind
  HTTP basic auth.
- **Tracing.** One trace per turn, one session per conversation, OTel
  GenAI attribute conventions, the prompt hash and the policy config hash
  stamped on every one. Export to Langfuse is optional.
- **Chat widget.** Dependency-free, rendered in a shadow root, one script
  tag to embed.
- **Seven adversarial scripts** in `scripts/attacks/`, and a demo that
  replays one of them against the running service and shows where the
  money went.

**In memory today.** The refund ledger, the audit log and the
conversations live inside the agent process. A restart clears them. The
demo says so at the end of every run. Postgres enters the stack with
retrieval, in the next block; persistence of these three arrives with
the first pilot. Caps come from a JSON file named in `.env`, or from the
built-in defaults when none is named.

## Repository layout

| Path                      | Package                   | What lives there                                                  |
| ------------------------- | ------------------------- | ----------------------------------------------------------------- |
| `packages/core`           | `@kept-hq/core`           | Trace layer, agent loop, tools, policy engine, ledger, inbox core |
| `packages/adapter-medusa` | `@kept-hq/adapter-medusa` | Medusa v2 implementation of `OrderBackend` (stretch)              |
| `packages/widget`         | `@kept-hq/widget`         | Embeddable chat widget                                            |
| `packages/evals`          | `@kept-hq/evals`          | YAML case format and the eval runner (next)                       |
| `packages/simulator`      | `@kept-hq/simulator`      | Persona-driven synthetic conversations (next)                     |
| `apps/agent`              | `@kept-hq/agent`          | Agent service (Node + Hono), serving the inbox at `/inbox`        |
| `apps/admin`              | —                         | Reserved; the v0 inbox is one page served by the agent service    |
| `scripts/`                | —                         | The scam demo, the attack driver, the adversarial scripts         |

## Quick start: five minutes, no Docker

Requirements: Node 24 or newer and pnpm. One model key, from Anthropic or
OpenAI.

```bash
git clone https://github.com/dragosbln/kept.git
cd kept
pnpm install
cp .env.example .env
```

Open `.env` and paste **one** key: `ANTHROPIC_API_KEY` or
`OPENAI_API_KEY`. The service picks the provider from whichever key is
present, with a cheap default model for each (Claude Haiku 4.5, or
gpt-5.6-luna). Nothing else needs changing.

```bash
pnpm start
```

The boot log names the model, the prompt version and the inbox address.
Leave it running and, in a second terminal, scam it:

```bash
pnpm demo:scam
```

The demo replays a two-chat attack against the running service. In the
first chat the customer gets a damaged pair of boots refunded. In a
second, fresh chat the same customer claims the refund never arrived and
asks for it again, then asks for a second item, then applies pressure.
The model in chat two has no memory of chat one. The ledger has: the
double dip is denied as already refunded, the second item lands in the
approval queue because the order's refunds would cross the per-order
cap, and the pressure changes nothing. The last thing the demo prints is
the link to that record in the inbox. Sign in with the username and
password from `.env` (`KEPT_INBOX_USER` and `KEPT_INBOX_PASSWORD`).

What you can do from there:

- **Approve** executes the refund through the same write path the agent
  uses, and the record turns `ok`. Approve is a human override: the caps
  are not re-evaluated and the audit trail says who did it.
- **Deny** closes it without touching the backend.
- **Take over** silences the agent on that conversation; the customer's
  next message gets a hand-off notice and the model is never called.
- A second click on any button is refused with a reason, not an error:
  double-click safety is the ledger's transition table, not the UI.

Any script in `scripts/attacks/` runs the same way, for example
`pnpm demo:scam --script sympathy`. Each run adds to the service's
in-memory ledger, so a second run of the same script meets its own
earlier refunds; restart `pnpm start` for a clean slate.

To talk to the agent yourself, start the widget playground:

```bash
pnpm demo:widget
```

and open the printed URL with `?endpoint=http://localhost:3100` appended.
Without that query parameter the playground runs on a scripted mock and
needs no server. The demo store has five orders to ask about:

| Order        | Customer         | State                                                                |
| ------------ | ---------------- | -------------------------------------------------------------------- |
| `order-1001` | dana@example.com | Shipped, in transit: sneakers and two packs of socks                 |
| `order-1002` | sam@example.com  | Two pairs of boots, one delivered, one in transit; insoles delivered |
| `order-1003` | kai@example.com  | Placed six hours ago, nothing shipped yet                            |
| `order-1004` | ana@example.com  | Delivered, in EUR: one rain jacket                                   |
| `order-1005` | sam@example.com  | Delivered three weeks ago: one base layer                            |

Use `pnpm dev` instead of `pnpm start` when editing the service: it
restarts on every file change, which also wipes the in-memory ledger,
so it is the wrong command for a demo.

## The full stack: traces in Langfuse

The second path adds Docker and shows every conversation as a trace.
Budget fifteen minutes on a first run, most of it pulling about five
gigabytes of images.

```bash
pnpm stack:up
```

That brings up Postgres with pgvector and a self-hosted Langfuse (with
the ClickHouse, MinIO and Redis it needs). First boot provisions a
Langfuse organisation, project, user and API keys from `.env`, so there
is no click-through setup. Postgres is not used by the agent yet; it is
there for retrieval, which comes next.

Then turn exporting on: in `.env`, uncomment the two lines
`LANGFUSE_PUBLIC_KEY` and `LANGFUSE_SECRET_KEY`. Their values match what
compose provisioned. Restart `pnpm start` and run `pnpm demo:scam` again.

| Service        | URL                         | Sign in                                                    |
| -------------- | --------------------------- | ---------------------------------------------------------- |
| Agent service  | http://localhost:3100       |                                                            |
| Approval inbox | http://localhost:3100/inbox | `KEPT_INBOX_USER` / `KEPT_INBOX_PASSWORD`                  |
| Langfuse       | http://localhost:3030       | `LANGFUSE_INIT_USER_EMAIL` / `LANGFUSE_INIT_USER_PASSWORD` |
| Postgres       | `localhost:5432`            | `POSTGRES_USER` / `POSTGRES_PASSWORD`                      |
| MinIO console  | http://localhost:9091       | `MINIO_ROOT_USER` / `MINIO_ROOT_PASSWORD`                  |

In Langfuse, open the project `kept-dev` and its Traces table: one row
per turn, one session per conversation, and the demo prints the session
ids to filter on. Inside a trace sit the model calls, the tool executions
with their result state, and the policy decision with its caps math.
Every value in `.env.example` is a development default; the
whole stack binds to `127.0.0.1`, and the file says which secrets to
regenerate before anything is exposed beyond a laptop.

## Configuration

Everything is read from `.env` at boot, and a bad configuration refuses
to start rather than failing on the first customer message.

| Variable                                      | Default                             | Meaning                                                                                            |
| --------------------------------------------- | ----------------------------------- | -------------------------------------------------------------------------------------------------- |
| `ANTHROPIC_API_KEY` / `OPENAI_API_KEY`        |                                     | Paste one. With both set, `KEPT_PROVIDER` must choose; the service refuses to guess.               |
| `KEPT_PROVIDER`                               | inferred from the key               | `anthropic` or `openai`                                                                            |
| `KEPT_MODEL`                                  | `claude-haiku-4-5` / `gpt-5.6-luna` | Per provider                                                                                       |
| `KEPT_MAX_TOKENS`                             | `1024`                              | Output budget per model call                                                                       |
| `KEPT_OPENAI_REASONING_EFFORT`                | `none`                              | OpenAI only. `none` for gpt-5.1 and later, `minimal` for gpt-5, empty for models without reasoning |
| `KEPT_PROMPT_VERSION`                         | `1.1.0`                             | `1.0.0` keeps the caps in the prompt: the guard the policy engine replaced, kept for comparison    |
| `KEPT_INBOX_USER` / `KEPT_INBOX_PASSWORD`     | `kept` / dev default                | The inbox credential. The username is the actor recorded on every inbox action.                    |
| `KEPT_POLICY_CONFIG`                          | unset                               | Path to a caps file, see [`config/README.md`](config/README.md); unset means the built-in defaults |
| `KEPT_ALLOWED_ORIGINS`                        | `*`                                 | CORS allowlist for the widget's origin, comma-separated                                            |
| `PORT`                                        | `3100`                              | Agent service port                                                                                 |
| `LANGFUSE_PUBLIC_KEY` / `LANGFUSE_SECRET_KEY` | unset                               | Set both to export traces; unset, traces stay in the process and the boot log says so              |

Caps are a JSON file: copy [`config/policy.example.json`](config/policy.example.json),
which spells out the built-in defaults, edit the amounts, and name it in
`KEPT_POLICY_CONFIG`. The same amounts apply in every supported currency
and are never converted; the per-customer and per-day windows are
trailing durations, not calendar days. A request equal to a cap is
allowed, a cap of zero sends every refund to a human, and a currency with
no caps fails closed. [`config/README.md`](config/README.md) has the full
semantics. The file's hash is printed at boot and stamped on every trace,
decision and ledger record.

## Everyday commands

| Command            | Does                                                                              |
| ------------------ | --------------------------------------------------------------------------------- |
| `pnpm start`       | Run the agent service (no file watcher; the one to demo against)                  |
| `pnpm dev`         | Run it under a file watcher; every restart wipes the in-memory ledger             |
| `pnpm demo:scam`   | Replay an adversarial script against the running service and print the inbox link |
| `pnpm demo:widget` | Serve the widget playground                                                       |
| `pnpm attack`      | Replay adversarial scripts in-process, several runs at a time, into a log         |
| `pnpm check`       | Everything the pre-commit hook runs, across the repo                              |
| `pnpm lint`        | Lint (oxlint); `pnpm lint:fix` applies safe fixes                                 |
| `pnpm format`      | Rewrite formatting (prettier)                                                     |
| `pnpm build`       | Build every package                                                               |
| `pnpm stack:up`    | Start Postgres and Langfuse                                                       |
| `pnpm stack:logs`  | Tail the local stack                                                              |
| `pnpm stack:down`  | Stop the stack, keep the data                                                     |
| `pnpm stack:reset` | Stop the stack and drop all volumes                                               |

### Pre-commit hook

`pnpm install` points `core.hooksPath` at [`.githooks/`](.githooks). The
hook runs the eval-boundary check, lint and format on staged files, a
typecheck, and the unit tests. Roughly 1.6s for a typical commit and
1.9s with the whole tree staged; about 1.3s of that is fixed cost —
mostly process startup for the repo-wide steps, not the checks
themselves.

It only ever checks; it never rewrites or re-stages your files. Fix
failures with `pnpm format` / `pnpm lint:fix` and re-stage, or bypass a
deliberate work-in-progress commit with `git commit --no-verify`.

The eval corpus, the fault-toggle matrix, and the Langfuse exporter
smoke test are deliberately **not** in the hook. They need the stack,
they are slow by design, and a slow hook is one people learn to skip.
They belong in CI.

## Architecture

Annotated architecture notes are written by hand as each piece lands, and
are not yet published here. Planned sections:

- The trace model: spans, OTel GenAI attribute conventions, what gets
  stamped on every conversation and why.
- The agent loop: states, stop conditions, streaming.
- The policy engine: how caps compose, and why prompt-level guards were
  tried first and abandoned.
- Tool-result states: why `unknown` is not `failed`, and what idempotency
  keys buy on top.
- The approval inbox: the ledger's transition table, and why approve is
  an override rather than a re-decision.
- Retrieval: chunking, thresholds, source tiers, staleness.
- The eval matrix: what each fault toggle proves.

Until then the code is commented for readers: every core module opens
with a comment stating its contract and invariants. Start with
[`packages/core/src/agent/loop.ts`](packages/core/src/agent/loop.ts) and
[`packages/core/src/tracing/types.ts`](packages/core/src/tracing/types.ts),
then [`packages/core/src/policy/engine.ts`](packages/core/src/policy/engine.ts)
and [`packages/core/src/refund-ledger/types.ts`](packages/core/src/refund-ledger/types.ts).
Decisions that are locked are recorded under
[`docs/decisions/`](docs/decisions/), starting with why eval assertions
read the in-process trace and never the Langfuse API.

## License

MIT — see [LICENSE](LICENSE).
