# Policy fixture corpus

Two fictional merchants, twenty documents: the knowledge base the demo
searches and the evals run against. Every name, address, number and
policy here is invented; any resemblance to a real business is
coincidental.

- `loomhaven/` — Loomhaven Apparel Co.: one US storefront, apparel,
  one return window, one refund method. The simple merchant.
- `averlane/` — Averlane Market: multi-vertical, US and EU/UK
  storefronts, a third-party marketplace, a paid membership. The
  complex one.

Each merchant has binding documents (the return, shipping and refund
policies, a holiday addendum) and help-center articles. The two tiers
are written the way real ones are: binding text is dated, versioned and
definitive; help articles are undated, friendlier and not always in
step with the policy they summarise. That divergence is deliberate. It
is what a support agent has to handle, and what Kept's retrieval
(source tiers, staleness) and its evals exercise.

## File format

Markdown with a flat frontmatter block. Sections are `## ` headings;
the first token of a heading (`§2`) is the section's citation ref. An
article without headings is ingested as one chunk whose ref is its doc
id.

```
---
doc_id: LH-RET
title: Loomhaven Apparel Co. — Return & Refund Policy
store_id: loomhaven
tier: binding            # binding | informational
version: "1.2"
effective_from: 2026-03-01   # binding only; informational: unknown
effective_to: none           # exclusive: the first day it no longer applies
jurisdiction: US             # informational, not used by retrieval
---
## §1 Scope and precedence

...
```

Informational documents carry no dates on purpose: their freshness is
unknown, and ingestion must never manufacture one from a file
timestamp. `effective_to` is exclusive, so an addendum that "expires
January 31" has `effective_to: 2026-02-01`.

Load with `pnpm kb:ingest`; the loader is
`packages/core/src/retrieval/fixtures/loader.ts`.
