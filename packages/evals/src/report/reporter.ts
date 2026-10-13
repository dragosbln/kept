// The human-readable report and the exit code. One line per case, the
// failing assertions under it with their reasons and a trace id, so a red
// can be opened in Langfuse by session without re-running anything.

import type { EvalCase } from '../case/schema.js';
import type { CaseOutcome, RunOutcome, SuiteReport } from '../run/types.js';

/** Per assertion id, in how many runs it failed. Errored runs count for nothing. */
export function assertionFailureCounts(outcome: CaseOutcome): Map<string, number> {
  const counts = new Map<string, number>();
  for (const run of outcome.runs) {
    if (run.status === 'error') continue;
    for (const assertion of run.assertions) {
      if (assertion.result.passed) continue;
      counts.set(assertion.id, (counts.get(assertion.id) ?? 0) + 1);
    }
  }
  return counts;
}

/** Non-zero when any case outside quarantine is not passed: failed and flaky are red, error blocks the job. */
export function exitCodeFor(report: SuiteReport): 0 | 1 {
  return report.cases.some((outcome) => !outcome.quarantined && outcome.verdict !== 'passed')
    ? 1
    : 0;
}

const MARK: Record<CaseOutcome['verdict'], string> = {
  passed: 'PASS ',
  failed: 'FAIL ',
  flaky: 'FLAKY',
  error: 'ERROR',
};

function shortId(traceId: string | undefined): string {
  return traceId ? ` [trace ${traceId.slice(0, 12)}]` : '';
}

function firstReason(
  runs: readonly RunOutcome[],
  assertionId: string,
): { reason: string; traceId?: string } | undefined {
  for (const run of runs) {
    if (run.status === 'error') continue;
    const found = run.assertions.find((a) => a.id === assertionId && !a.result.passed);
    if (found && !found.result.passed) {
      return {
        reason: found.result.reason,
        ...(found.result.traceId === undefined ? {} : { traceId: found.result.traceId }),
      };
    }
  }
  return undefined;
}

function describeOutcome(outcome: CaseOutcome, evalCase: EvalCase | undefined): string[] {
  const runs = outcome.runs.length;
  const title = evalCase?.title ?? outcome.caseId;
  const lines: string[] = [];
  const suffix = outcome.quarantined ? '  (quarantined, not gating)' : '';
  switch (outcome.verdict) {
    case 'passed':
      lines.push(`  ${MARK.passed} ${outcome.caseId}  ${title}${suffix}`);
      break;
    case 'failed':
    case 'flaky': {
      lines.push(`  ${MARK[outcome.verdict]} ${outcome.caseId}  ${title}${suffix}`);
      for (const [id, failures] of assertionFailureCounts(outcome)) {
        const detail = firstReason(outcome.runs, id);
        lines.push(
          `        ${id}  ${failures}/${runs}  ${detail?.reason ?? ''}${shortId(detail?.traceId)}`,
        );
      }
      break;
    }
    case 'error': {
      lines.push(`  ${MARK.error} ${outcome.caseId}  ${title}${suffix}`);
      const errored = outcome.runs.find((run) => run.status === 'error');
      if (errored?.status === 'error') {
        lines.push(`        ${errored.error.kind}: ${errored.error.message}`);
      }
      break;
    }
  }
  return lines;
}

export function formatSuiteReport(report: SuiteReport, cases: readonly EvalCase[] = []): string {
  const byId = new Map(cases.map((evalCase) => [evalCase.id, evalCase]));
  const tally = { passed: 0, failed: 0, flaky: 0, error: 0, quarantined: 0 };
  for (const outcome of report.cases) {
    tally[outcome.verdict] += 1;
    if (outcome.quarantined) tally.quarantined += 1;
  }
  const toggles = report.config.faultToggles.length
    ? report.config.faultToggles.join(', ')
    : 'none';
  const seconds = Math.round((report.finishedAt - report.startedAt) / 1000);
  const header = `evals: ${report.cases.length} case(s) × ${report.config.runs} run(s), toggles: ${toggles}, ${seconds}s`;
  const summary = `${tally.passed} passed, ${tally.failed} failed, ${tally.flaky} flaky, ${tally.error} error, ${tally.quarantined} quarantined`;
  const body = report.cases.flatMap((outcome) =>
    describeOutcome(outcome, byId.get(outcome.caseId)),
  );
  return [header, ...body, summary, `exit ${exitCodeFor(report)}`].join('\n');
}
