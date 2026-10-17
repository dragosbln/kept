// The fault toggles: named faults a deployment can run under, so the eval
// matrix can prove the suite notices each one. Off in production; on, one
// at a time, in a CI job whose expected reds the cases list under
// `expectRedUnder`. Only the names live here. What each one does is
// hand-written at its seam, and the host stamps the active set on every
// trace, so a reader of a trace can tell a fault from a regression.
//
//   caps-per-call-only    policy/fault-toggles.ts               the engine runs with every cap but per_call filtered out
//   swallow-tool-errors   agent/executor.ts                     failed and unknown tool results reach the model as ok
//   retrieval-scope-off   retrieval/service.ts                  the knowledge-base query drops the store filter
//   stale-kb              retrieval/service.ts                  the binding query drops the effective-date window
//   skip-identity-check   identity/gate.ts, tools/registry.ts   verify answers ok to any pair and the order tools' gate passes without it

export const FAULT_TOGGLES = [
  'caps-per-call-only',
  'swallow-tool-errors',
  'retrieval-scope-off',
  'stale-kb',
  'skip-identity-check',
] as const;

export type FaultToggle = (typeof FAULT_TOGGLES)[number];

export function isFaultToggle(value: string): value is FaultToggle {
  return (FAULT_TOGGLES as readonly string[]).includes(value);
}

/**
 * KEPT_FAULT_TOGGLES as the host reads it: comma-separated names, whitespace
 * tolerated, duplicates collapsed, unset or blank means none. An unknown
 * name throws naming the list: a boot-time refusal, like a bad caps file,
 * never a silently ignored fault.
 */
export function parseFaultToggles(raw: string | undefined): FaultToggle[] {
  const names = (raw ?? '')
    .split(',')
    .map((name) => name.trim())
    .filter((name) => name.length > 0);
  const toggles: FaultToggle[] = [];
  for (const name of names) {
    if (!isFaultToggle(name)) {
      throw new Error(
        `KEPT_FAULT_TOGGLES: unknown fault toggle "${name}"; one of ${FAULT_TOGGLES.join(', ')}`,
      );
    }
    if (!toggles.includes(name)) toggles.push(name);
  }
  return toggles;
}

/**
 * What a seam throws while its toggle has no body yet. An unimplemented
 * toggle fails loudly instead of silently doing nothing: a matrix run that
 * found no red because the fault never happened would read as a finding.
 */
export function faultToggleNotImplemented(toggle: FaultToggle): never {
  throw new Error(`fault toggle "${toggle}" is not implemented yet: hand-written in block 4`);
}
