# Kept

Open-source, self-hostable post-purchase support agent for e-commerce
(WISMO, returns, refunds) with the trust layer as the product: approval
queue, composed caps, idempotency, audit trail, versioned prompts, CI
evals, tracing, fault-injection toggles. TypeScript. MIT. Medusa-first
adapter over a platform-agnostic core.

## Repo shape

pnpm monorepo, packages ship under the `@kept` npm scope:
`@kept/core` · `@kept/adapter-medusa` · `@kept/widget` · `@kept/evals`
· `@kept/simulator`. Apps: approval inbox + admin (Next.js), agent
service (Node/Hono).

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
- Postgres + pgvector, Drizzle. One database, boring.

## Working rules for Claude in this repo

- Read `CLAUDE.local.md` first — it defines the collaboration contract
  for this project and always takes precedence.
- Never commit anything from `internal/` or the journal; they are
  gitignored on purpose. This repo goes public later and git history
  is forever.
