# Kept

Open-source, self-hostable post-purchase support agent for e-commerce
(WISMO, returns, refunds) with the trust layer as the product: approval
queue, composed caps, idempotency, audit trail, versioned prompts, CI
evals, tracing, fault-injection toggles. TypeScript. MIT. Medusa-first
adapter over a platform-agnostic core.

## Repo shape

pnpm monorepo, packages ship under the `@kept-hq` npm scope (`@kept`
was already taken on npm — see `internal/registrations.md`):
`@kept-hq/core` · `@kept-hq/adapter-medusa` · `@kept-hq/widget` ·
`@kept-hq/evals` · `@kept-hq/simulator`. Apps: approval inbox + admin
(Next.js), agent service (Node/Hono). Product name stays "Kept" in all
user-facing copy; the scope is packaging, not brand.

## Engineering conventions

- The agent loop is hand-rolled on the provider SDK behind a thin
  `ModelClient` interface — no agent frameworks.
- Deterministic first: safety checks live in the tool/policy layer,
  never only in the prompt. Tool results distinguish ok / failed /
  unknown. All writes carry idempotency keys.
- Tracing before features: OTel GenAI conventions + Langfuse; every
  conversation is a trace; prompt hash + config stamped on every one.
- Evals are YAML cases run by our own runner; assertions may inspect
  trace internals. 3× stability rule; flaky cases are quarantined the
  day they flake. The CI fault-toggle matrix (faults off → green, each
  fault on → specific reds) must stay meaningful.
- **Langfuse is a sink for humans, not a source for machines** (locked;
  see `docs/decisions/0001-eval-assertions-read-the-in-process-trace.md`).
  Eval assertions read the in-process Trace/span model, never the
  Langfuse API. The runner executes the agent in-process, and assertion
  types take our Trace model as input — not Langfuse response shapes.
  The eval suite and the fault-toggle matrix must run with Postgres
  alone, no Langfuse containers. Exporter coverage lives in exactly one
  smoke test outside the matrix, which is the only code in the repo
  permitted to touch the Langfuse read API.
- Postgres + pgvector, Drizzle. One database, boring.

## Working rules for Claude in this repo

- Read `CLAUDE.local.md` first — it defines the collaboration contract
  for this project and always takes precedence.
- Never commit anything from `internal/` or the journal; they are
  gitignored on purpose. This repo goes public later and git history
  is forever.
