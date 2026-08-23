# 1. Eval assertions read the in-process trace, never the Langfuse API

Date: 2026-08-10
Status: accepted

## Context

Every conversation is a trace, and assertions are supposed to inspect
trace internals — cited documents, tool-call sequence, no-write-before-
confirm. Those facts exist in two places once tracing is wired up: the
in-process Trace/span model, and Langfuse after export.

Reading them back out of Langfuse is superficially attractive: the data
is already shaped, queryable, and visible in a UI next to the failure.
It is the wrong source.

## Decision

**Langfuse is a sink for humans, not a source for machines.**

- The eval runner executes the agent in-process. Assertion types take
  our `Trace`/span model as input, not Langfuse API response shapes.
- The eval suite and the CI fault-toggle matrix run with Postgres alone.
  No Langfuse containers, no ClickHouse, no Redis, no MinIO.
- No Langfuse read-API imports in `@kept-hq/evals` or `@kept-hq/core`.
- Exporter coverage lives in **one** smoke test, outside the eval
  matrix: run a single conversation, poll the Langfuse public API with
  a timeout until the trace appears, then verify it carries the expected
  spans and the prompt-hash/config stamp. That test is the only code in
  the repository permitted to touch the Langfuse read API, and it is
  allowed to be slow.

## Consequences

**The matrix stays honest.** A fault toggle is supposed to turn specific
cases red. If assertions read from Langfuse, an export bug, a dropped
batch, or ClickHouse lag produces reds that look identical to a real
policy regression. The signal the whole launch rests on would be
diluted by infrastructure noise.

**The matrix stays fast and hermetic.** Five services and an
eventually-consistent ingestion pipeline are a poor thing to put on the
critical path of a test suite meant to run on every push. Assertions
against an in-process object are synchronous and exact — no polling,
no flake, nothing to retry. This matters directly for the 3× stability
rule: a suite that reads over a network is a suite that generates
quarantine candidates for reasons that have nothing to do with the
agent.

**The trace model stays the real interface.** Assertions written against
our own model keep pressure on that model to be good, because it is
load-bearing for testing rather than merely for display. Assertions
written against Langfuse response shapes would couple the eval suite to
a vendor's API, and a Langfuse major version would become an eval-suite
migration.

**The export path still gets covered — once.** The risk this decision
accepts is that the exporter silently breaks while every eval stays
green. That is precisely what the smoke test exists to catch, and
keeping it to one slow test outside the matrix means the coverage
exists without the cost being paid on every case.

## Enforcement

`scripts/check-eval-boundary.mjs`, wired into `pnpm check`, fails if
`@kept-hq/evals` declares a Langfuse dependency or imports one, or reads
`LANGFUSE_*` configuration. It runs on the checkable half of the rule.

The `@kept-hq/core` half is not yet mechanically enforced: core legitimately
imports the Langfuse SDK for _export_, so the ban is on the read surface
specifically. Once the exporter exists and its location is settled, the
check can be tightened to confine Langfuse imports in core to that module
and to assert the read surface appears nowhere but the smoke test.

### Amendment (2026-08-23)

The paragraph above is superseded. The exporter landed as a plain
`fetch()` OTLP/HTTP transport, so core imports no Langfuse SDK even for
export, and transport credentials are injected by the app rather than
read from the environment by core. That let the check go further than
originally planned: `scripts/check-eval-boundary.mjs` now enforces both
halves — it seals `@kept-hq/evals` entirely (no dependency, no import,
no `LANGFUSE_*` read) and scans `packages/core/src` for any Langfuse
import or `LANGFUSE_*` read, with a single exemption for
`*.smoke.test.*` files, the ADR's one permitted read-API caller.
