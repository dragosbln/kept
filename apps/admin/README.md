# Approval inbox + admin

Not scaffolded yet — deliberately. This app arrives in week 2 (days 4–5),
and scaffolding Next.js now would add a dependency tree and a set of
framework decisions a week before the first line of UI gets written.

When it lands:

- Pending action view: the conversation, the policy excerpt that fired,
  the caps arithmetic, and approve / deny / take over.
- Backed by an append-only audit log.
- The state machine behind it is hand-written; the UI is not.

It takes host port 3000, which is why Langfuse is published on 3030.
