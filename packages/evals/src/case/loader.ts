// Reads case files and the quarantine list from disk. Every error names the
// file: a case that does not parse is a build failure with a path, not a
// stack trace from the middle of a run.

import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { parseEvalCase, parseQuarantine, type EvalCase, type QuarantineEntry } from './schema.js';

/** The cases that ship with the repo. */
export const CASES_DIR = fileURLToPath(new URL('../../cases/', import.meta.url));

/** The quarantine list lives beside the cases; it is a list, so an empty file is an empty list. */
export const QUARANTINE_FILE = path.join(CASES_DIR, 'quarantine.yaml');

/** A case plus where it was read from, for the report. */
export type LoadedEvalCase = EvalCase & { file: string };

const CASE_EXTENSIONS = new Set(['.yaml', '.yml']);

async function readYaml(file: string): Promise<unknown> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    throw new Error(`${file}: cannot read (${error instanceof Error ? error.message : error})`, {
      cause: error,
    });
  }
  try {
    return YAML.parse(text);
  } catch (error) {
    throw new Error(`${file}: not valid YAML (${error instanceof Error ? error.message : error})`, {
      cause: error,
    });
  }
}

export async function loadEvalCase(file: string): Promise<LoadedEvalCase> {
  const absolute = path.resolve(file);
  const raw = await readYaml(absolute);
  return { ...parseEvalCase(raw, absolute), file: absolute };
}

/**
 * Every case file in a directory, sorted by id. Two files with one id is an
 * error here, because the quarantine list and `--case` address cases by id.
 */
export async function loadEvalCases(dir: string = CASES_DIR): Promise<LoadedEvalCase[]> {
  const names = (await readdir(dir)).filter(
    (name) =>
      CASE_EXTENSIONS.has(path.extname(name)) && path.resolve(dir, name) !== QUARANTINE_FILE,
  );
  const cases = await Promise.all(names.map((name) => loadEvalCase(path.join(dir, name))));
  const byId = new Map<string, LoadedEvalCase>();
  for (const evalCase of cases) {
    const other = byId.get(evalCase.id);
    if (other) {
      throw new Error(
        `case id "${evalCase.id}" is used by both ${path.relative(dir, other.file)} and ${path.relative(dir, evalCase.file)}`,
      );
    }
    byId.set(evalCase.id, evalCase);
  }
  return [...byId.values()].toSorted((a, b) => a.id.localeCompare(b.id, 'en'));
}

/** The quarantine list; a missing file is an empty list. */
export async function loadQuarantine(file: string = QUARANTINE_FILE): Promise<QuarantineEntry[]> {
  let raw: unknown;
  try {
    raw = await readYaml(file);
  } catch (error) {
    if ((error as { cause?: { code?: string } }).cause?.code === 'ENOENT') return [];
    throw error;
  }
  return parseQuarantine(raw, file);
}
