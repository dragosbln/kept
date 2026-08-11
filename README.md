# Kept

Open-source, self-hostable post-purchase support agent for e-commerce —
answers "where is my order", executes returns and refunds — where the
trust layer is the product: approval queue, caps that compose,
idempotency, audit trail, versioned prompts, CI evals, tracing, and
fault-injection toggles.

Medusa-first adapter over a platform-agnostic core. TypeScript. MIT.

> Status: pre-v0, under active construction. Nothing here is stable yet.

## Repository layout

| Path                      | Package                   | What lives there                                        |
| ------------------------- | ------------------------- | ------------------------------------------------------- |
| `packages/core`           | `@kept-hq/core`           | Trace layer, agent loop, tool + policy layer, retrieval |
| `packages/adapter-medusa` | `@kept-hq/adapter-medusa` | Medusa v2 implementation of `OrderBackend`              |
| `packages/widget`         | `@kept-hq/widget`         | Embeddable chat widget                                  |
| `packages/evals`          | `@kept-hq/evals`          | YAML case format and the eval runner                    |
| `packages/simulator`      | `@kept-hq/simulator`      | Persona-driven synthetic conversations                  |
| `apps/agent`              | `@kept-hq/agent`          | Agent service (Node + Hono)                             |
| `apps/admin`              | —                         | Approval inbox + admin (Next.js)                        |

## Getting started

Requirements: Node >= 24, pnpm, and Docker.

```bash
pnpm install
cp .env.example .env
pnpm stack:up
```

That brings up Postgres (with pgvector) and a self-hosted Langfuse. First
boot provisions a Langfuse org, project, and API keys from `.env`, so
there is no click-through setup.

| Service        | URL                   |
| -------------- | --------------------- |
| Langfuse       | http://localhost:3030 |
| Agent service  | http://localhost:3100 |
| Approval inbox | http://localhost:3000 |
| Postgres       | `localhost:5432`      |
| MinIO console  | http://localhost:9091 |

Then:

```bash
pnpm dev
```

### Everyday commands

| Command            | Does                                                 |
| ------------------ | ---------------------------------------------------- |
| `pnpm check`       | Everything the pre-commit hook runs, across the repo |
| `pnpm lint`        | Lint (oxlint); `pnpm lint:fix` applies safe fixes    |
| `pnpm format`      | Rewrite formatting (prettier)                        |
| `pnpm build`       | Build every package                                  |
| `pnpm stack:logs`  | Tail the local stack                                 |
| `pnpm stack:down`  | Stop the stack, keep the data                        |
| `pnpm stack:reset` | Stop the stack and drop all volumes                  |

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

<!--
  TODO (hand-written, per the learning contract): the annotated
  architecture sections are the public form of the exit test and are not
  to be ghost-written.

  - The trace model: spans, OTel GenAI attribute conventions, what gets
    stamped on every conversation and why.
  - The agent loop: states, stop conditions, streaming.
  - The policy engine: how caps compose, and why prompt-level guards were
    tried first and abandoned.
  - Tool-result states: why `unknown` is not `failed`.
  - Retrieval: chunking, thresholds, source tiers, staleness.
  - The eval matrix: what each fault toggle proves.
-->

## License

MIT — see [LICENSE](LICENSE).
