# @kept-hq/widget

Embeddable post-purchase support chat widget for the Kept agent
service. Dependency-free, framework-free, rendered into a shadow root
so storefront CSS and widget CSS cannot touch each other. Ships two
artifacts from one source tree:

- **Typed ESM** (`dist/index.js` + `.d.ts`, via `tsc`) for npm
  consumers — any framework, or none.
- **Script-tag embed** (`dist/kept-widget.js`, via esbuild) — a single
  minified IIFE a merchant pastes into any page.

Status: v0. Non-streaming by design (the agent loop returns outcomes
whole in v0); the transport is an interface, so streaming later is a
new transport, not a rewrite.

## Quick start

Script tag:

```html
<script
  src="/path/to/kept-widget.js"
  data-kept-endpoint="https://agent.example.com"
></script>
```

Programmatic (ESM):

```ts
import { createKeptWidget } from '@kept-hq/widget';

const widget = createKeptWidget({
  endpoint: 'https://agent.example.com',
});
// widget.open() / .close() / .toggle() / .startOver() / .destroy()
```

Local playground (mock transport, no server needed):

```bash
pnpm demo:widget
```

then open the printed URL. Add `?endpoint=http://localhost:3100` to
point the demo at a running agent service instead of the mock.

## Configuration

| Key                | Default          | Notes                                                           |
| ------------------ | ---------------- | --------------------------------------------------------------- |
| `endpoint`         | —                | Agent service base URL. Required unless `transport` is set.     |
| `transport`        | HTTP transport   | Bring-your-own `KeptTransport` (demo mock, tests, custom auth). |
| `title`            | "Support"        | Header + dialog label. Alias for `strings.title`.               |
| `greeting`         | built-in copy    | First agent bubble, rendered locally — never a server turn.     |
| `position`         | `right`          | `right` \| `left`.                                              |
| `accentColor`      | Kept green       | Any CSS color; also see CSS custom properties below.            |
| `zIndex`           | 2147482000       | High but not maximal.                                           |
| `storage`          | `session`        | `session` \| `local` \| `none` — see privacy note.              |
| `storageKey`       | `kept-widget`    | Namespace when two widgets share an origin.                     |
| `requestTimeoutMs` | 60000            | Whole-turn budget (a turn may run several tool rounds).         |
| `maxMessageLength` | 2000             | Hard cap on the composer.                                       |
| `openOnLoad`       | `false`          | Opens the panel without stealing focus.                         |
| `target`           | `document.body`  | Mount point.                                                    |
| `strings`          | English defaults | Full copy table override — the localization seam.               |

Script-tag attributes mirror the basics: `data-kept-endpoint`,
`data-kept-title`, `data-kept-greeting`, `data-kept-position`,
`data-kept-accent-color`, `data-kept-storage`, `data-kept-z-index`,
`data-kept-open`.

## Wire contract (the seam with the agent service)

Defined in `src/protocol/types.ts`, deliberately **not** imported from
`@kept-hq/core`: the widget is a browser client of an HTTP API, so its
contract is the JSON on the wire, validated on arrival. The outcome
names mirror the agent loop's terminal states 1:1. If the handler's HTTP
shape changes, `protocol/types.ts` and `transport/http.ts` are the only
files that change.

```
POST {endpoint}/chat
content-type: application/json

{ "message": string,
  "conversationId"?: string,      // omitted on the first turn
  "clientMessageId": string }     // stable across retries; v0 handler ignores it

200 → { "conversationId": string,
        "outcome": { "type": "reply", "message": string }
                 | { "type": "failed", "reason": string }
                 | { "type": "conversation_full" } }

400 → { "error": string }         // invalid body
404 → { "error": string }         // unknown conversationId
```

Turn-level failures are HTTP 200: the handler did its job, the _turn_
ended in a non-reply outcome. HTTP status codes describe the exchange;
outcomes describe the turn. Failure reasons the loop emits today:
`internal`, `max_rounds`, `refusal`, `max_tokens`, `unknown_stop_reason`,
`empty_reply` — the parser accepts any non-empty string, because every
reason renders with the same copy and a new server-side reason must not
break a deployed widget. Outcome _types_ are strict.

What the server side provides:

1. The route above, one customer message per call.
2. CORS for the storefront origin, configured with `KEPT_ALLOWED_ORIGINS`
   on the agent service (the widget POSTs cross-origin).
3. A per-conversation lock that _queues_ concurrent turns rather than
   rejecting them — so there is no 409 in v0. The widget's
   `conversation_locked` copy stays wired for a server that chooses to
   reject instead; the mock's `/locked` command exercises that path.

## Delivery states — the trust UX

Every customer message carries a delivery state, applying the tool
layer's ok / failed / unknown rule to the transport:

| State       | Claimed when                                                                                                                           |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `sending`   | In flight.                                                                                                                             |
| `delivered` | A `reply` outcome came back.                                                                                                           |
| `failed`    | The server is **known** not to have processed the turn: a failed outcome, or an HTTP 4xx refusal.                                      |
| `unknown`   | Anything ambiguous: network error, timeout, 5xx, unreadable 200. Shown as "delivery unconfirmed", never coerced to success or failure. |

Retry is customer-initiated only (the widget never auto-retries a
non-idempotent send), only for the most recent message, and reuses the
original `clientMessageId` so a deduping server can make
retry-after-unknown exactly-once. Retrying after a _failed outcome_ is
safe by the loop's own invariant: failed terminals return the server
history unchanged.

## Theming

Override the custom properties on the host element from page CSS:

```css
[data-kept-widget] {
  --kept-accent: #4338ca;
  --kept-accent-strong: #3730a3;
  /* --kept-on-accent, --kept-surface, --kept-surface-muted,
     --kept-border, --kept-text, --kept-text-muted */
}
```

All sizes are px (host-page `rem` must not leak in), the font stack is
self-contained, and `prefers-reduced-motion` disables all animation.
Single light theme in v0.

## Privacy & security notes

- Default storage is `sessionStorage` (per-tab, gone when the tab
  closes) because transcripts contain order details. `local` opts into
  cross-visit persistence; `none` disables persistence.
- Message content only ever reaches the DOM as text nodes. The one
  exception is anchors around substrings of _agent_ text that re-parse
  as strict `http(s)` URLs (tracking links must be clickable). All of
  that lives in `src/ui/linkify.ts`.
- No auth in v0: the conversation id is the bearer capability. Do not
  put secrets in widget config — it ships to the browser.

## Architecture

```
src/
  protocol/   wire types + strict response parsing (the contract)
  transport/  KeptTransport seam: http (fetch, timeout, no auto-retry),
              mock (scripted demo incl. forced failure modes)
  state/      store (state machine, single-flight, delivery states),
              session (versioned persistence), types
  strings.ts  every customer-visible string, in one table
  config.ts   public config → resolved config (no optionals past here)
  ui/         shadow-DOM mount, item rendering, linkify, icons, styles
  index.ts    createKeptWidget — composition root
  embed.ts    script-tag entry (auto-mount from data-attributes)
```

No UI framework, deliberately: an embeddable widget pays for a
framework twice (bundle weight on every storefront, and version
coexistence with the host app). The embed stays ~8 kB min+gz. State →
DOM flows through one `render(state)` per store change; log nodes are
reused by item id. If the widget ever needs a framework, `protocol/`,
`transport/`, `state/`, `strings.ts`, and `config.ts` move unchanged —
only `ui/` is DOM-bound.
