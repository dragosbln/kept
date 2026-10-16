// Renders the eval reports of one matrix run as a Markdown grid, cases by
// toggles, for the CI job summary: the launch screenshot. Reads the JSON
// reports `pnpm evals --json` writes, nothing else (ADR 0001).
//
//   pnpm evals:summary reports/*.json
//
// A cell is the case's standing in that job: green, red where the case
// listed it, a missed red, an unexpected red, or void. A toggle column
// that no assertion lists is called out: the matrix proves nothing for it.

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { FAULT_TOGGLES, exitCodeFor, exitCodeForMatrix } from '../packages/evals/src/index.ts';
import type { CaseOutcome, MatrixResult, SuiteReport } from '../packages/evals/src/index.ts';

type Report = SuiteReport & { matrix?: MatrixResult; model?: string; promptVersion?: string };

const CELL = {
  green: '✅',
  red: '🔴',
  missed: '❌',
  unexpected: '⚠️',
  void: '⬜',
  failed: '❌',
  flaky: '🟡',
  absent: '·',
} as const;

function label(report: Report): string {
  return report.config.faultToggles.length > 0
    ? report.config.faultToggles.join(' + ')
    : 'faults off';
}

/** Faults off first, then toggles in the vocabulary's order. */
function order(report: Report): number {
  const first = report.config.faultToggles[0];
  return first === undefined ? -1 : (FAULT_TOGGLES as readonly string[]).indexOf(first);
}

function suiteCell(outcome: CaseOutcome): string {
  const mark =
    outcome.verdict === 'passed'
      ? CELL.green
      : outcome.verdict === 'flaky'
        ? CELL.flaky
        : outcome.verdict === 'error'
          ? CELL.void
          : CELL.failed;
  return outcome.quarantined ? `${mark} q` : mark;
}

function matrixCell(matrix: MatrixResult, caseId: string): string {
  const entries = matrix.entries.filter((entry) => entry.caseId === caseId);
  if (entries.length === 0) return CELL.absent;
  const verdicts = new Set(entries.map((entry) => entry.verdict));
  const mark = verdicts.has('void')
    ? CELL.void
    : verdicts.has('unexpected-red')
      ? CELL.unexpected
      : verdicts.has('missed-red')
        ? CELL.missed
        : entries.some((entry) => entry.expected === 'red')
          ? CELL.red
          : CELL.green;
  return entries.some((entry) => entry.quarantined) ? `${mark} q` : mark;
}

function cell(report: Report, caseId: string): string {
  if (report.matrix) return matrixCell(report.matrix, caseId);
  const outcome = report.cases.find((candidate) => candidate.caseId === caseId);
  return outcome ? suiteCell(outcome) : CELL.absent;
}

function footer(report: Report): string {
  if (!report.matrix) {
    const tally = { passed: 0, failed: 0, flaky: 0, error: 0 };
    for (const outcome of report.cases) tally[outcome.verdict] += 1;
    return `${tally.passed} passed, ${tally.failed} failed, ${tally.flaky} flaky, ${tally.error} error · exit ${exitCodeFor(report)}`;
  }
  const { entries } = report.matrix;
  const listed = entries.filter((entry) => entry.expected === 'red');
  const hit = listed.filter((entry) => entry.verdict === 'as-expected').length;
  const unexpected = entries.filter((entry) => entry.verdict === 'unexpected-red').length;
  const voids = entries.filter((entry) => entry.verdict === 'void').length;
  const warning =
    listed.length === 0
      ? ' · **no assertion lists this toggle: the matrix proves nothing for it**'
      : '';
  return `${hit}/${listed.length} listed reds hit, ${unexpected} unexpected, ${voids} void · exit ${exitCodeForMatrix(report.matrix)}${warning}`;
}

async function main(files: string[]): Promise<void> {
  if (files.length === 0) {
    console.error('usage: pnpm evals:summary reports/*.json');
    process.exit(1);
  }
  const reports = await Promise.all(
    files.map(async (file) => JSON.parse(await readFile(path.resolve(file), 'utf8')) as Report),
  );
  reports.sort((a, b) => order(a) - order(b));

  const caseIds: string[] = [];
  for (const report of reports) {
    for (const outcome of report.cases) {
      if (!caseIds.includes(outcome.caseId)) caseIds.push(outcome.caseId);
    }
  }

  const first = reports[0]!;
  const lines = [
    '## Fault-toggle matrix',
    '',
    `${first.model ?? 'model unknown'} · prompt ${first.promptVersion ?? '?'} · ${first.config.runs} runs per case · ${reports.length} job(s)`,
    '',
    `| case | ${reports.map(label).join(' | ')} |`,
    `|---|${reports.map(() => ':---:').join('|')}|`,
    ...caseIds.map(
      (caseId) =>
        `| \`${caseId}\` | ${reports.map((report) => cell(report, caseId)).join(' | ')} |`,
    ),
    `| | ${reports.map(footer).join(' | ')} |`,
    '',
    `${CELL.green} green · ${CELL.red} red where the case listed the toggle · ${CELL.missed} listed and never red (missed) · ${CELL.unexpected} red where nothing listed it · ${CELL.flaky} flaky with faults off · ${CELL.void} no verdict, a run errored · q quarantined, never gating`,
  ];
  console.log(lines.join('\n'));
}

main(process.argv.slice(2)).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
