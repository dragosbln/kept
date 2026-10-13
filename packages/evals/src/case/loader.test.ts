// The shipped cases are the first consumers of the format: every file in
// cases/ parses, ids are unique, and the quarantine list loads. A case that
// stops parsing fails here, on every push, before any model is called.

import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CASES_DIR, loadEvalCases, loadQuarantine } from './loader.js';

describe('the shipped cases', () => {
  it('every case parses, ids are unique, and every case has a smoke or attack or retrieval tag', async () => {
    const cases = await loadEvalCases(CASES_DIR);
    expect(cases.length).toBeGreaterThanOrEqual(12);
    const ids = cases.map((evalCase) => evalCase.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const evalCase of cases) {
      expect(evalCase.file.startsWith(CASES_DIR)).toBe(true);
      expect(evalCase.tags.length, `${evalCase.id} has no tags`).toBeGreaterThan(0);
    }
  });

  it('the quarantine list loads, and a missing one is empty', async () => {
    const shipped = await loadQuarantine();
    expect(Array.isArray(shipped)).toBe(true);
    expect(await loadQuarantine(path.join(CASES_DIR, 'no-such-file.yaml'))).toEqual([]);
  });
});

describe('loadEvalCases', () => {
  it('refuses two files with one id, naming both', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'kept-evals-'));
    const body = [
      'id: twin',
      'title: Twin',
      'storeId: loomhaven',
      'clock: 2026-09-10T12:00:00Z',
      'steps:',
      '  - kind: customer_message',
      '    message: hi',
      'assertions:',
      '  - kind: turn_outcome',
      '    expected: { type: reply }',
      '',
    ].join('\n');
    await writeFile(path.join(dir, 'a.yaml'), body);
    await writeFile(path.join(dir, 'b.yaml'), body);
    await expect(loadEvalCases(dir)).rejects.toThrow(/"twin" is used by both a\.yaml and b\.yaml/);
  });

  it('names the file on a YAML or schema error', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'kept-evals-'));
    await writeFile(path.join(dir, 'bad.yaml'), 'id: [unterminated');
    await expect(loadEvalCases(dir)).rejects.toThrow(/bad\.yaml: not valid YAML/);
    await writeFile(path.join(dir, 'bad.yaml'), 'id: nope\n');
    await expect(loadEvalCases(dir)).rejects.toThrow(/bad\.yaml: not a valid eval case/);
  });
});
