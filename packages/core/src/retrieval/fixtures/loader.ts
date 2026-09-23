// Reads policy documents written as Markdown with a small frontmatter block
// (the format of packages/core/fixtures/policy-docs, see its README) into
// SourceDocuments. Sections are `## ` headings; the first token of a heading
// is the section ref. An article without headings is one section whose ref
// is the doc id. No YAML library: the frontmatter is flat `key: value`.

import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { parseSourceDocument, type SourceDocument } from '../source-document.js';

/** The fixture corpus that ships with the repo: two fictional merchants, 20 documents. */
export const POLICY_FIXTURES_DIR = fileURLToPath(
  new URL('../../../fixtures/policy-docs/', import.meta.url),
);

type Frontmatter = Record<string, string>;

function splitFrontmatter(
  markdown: string,
  sourceName: string,
): { meta: Frontmatter; body: string } {
  const lines = markdown.split('\n');
  if (lines[0]?.trim() !== '---') {
    throw new Error(`${sourceName}: missing frontmatter (the file must start with ---)`);
  }
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === '---');
  if (end === -1) {
    throw new Error(`${sourceName}: unterminated frontmatter`);
  }
  const meta: Frontmatter = {};
  for (const line of lines.slice(1, end)) {
    if (line.trim() === '') continue;
    const match = line.match(/^([A-Za-z_]\w*):\s*(.*)$/);
    if (!match) {
      throw new Error(`${sourceName}: frontmatter line is not "key: value": ${line}`);
    }
    meta[match[1]!] = match[2]!.trim().replace(/^"(.*)"$/, '$1');
  }
  return { meta, body: lines.slice(end + 1).join('\n') };
}

/** `YYYY-MM-DD` to epoch ms at UTC midnight; `unknown`, `none` and absence are null. */
function dateOrNull(value: string | undefined, field: string, sourceName: string): number | null {
  if (value === undefined || value === '' || value === 'unknown' || value === 'none') {
    return null;
  }
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) {
    throw new Error(
      `${sourceName}: ${field} must be YYYY-MM-DD, "unknown" or "none"; got "${value}"`,
    );
  }
  return Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
}

const SECTION_HEADING = /^## (.+)$/m;

export function parsePolicyMarkdown(markdown: string, sourceName = 'inline'): SourceDocument {
  const { meta, body } = splitFrontmatter(markdown, sourceName);
  const docId = meta['doc_id'] ?? '';
  const title = meta['title'] ?? '';

  const parts = body.split(SECTION_HEADING);
  const sections: SourceDocument['sections'] = [];
  for (let index = 1; index < parts.length; index += 2) {
    const heading = parts[index]!.trim();
    const text = (parts[index + 1] ?? '').trim();
    sections.push({ ref: heading.split(/\s+/)[0] ?? heading, heading, text });
  }
  if (sections.length === 0) {
    sections.push({ ref: docId, heading: title, text: body.trim() });
  }

  try {
    return parseSourceDocument({
      docId,
      storeId: meta['store_id'],
      title,
      tier: meta['tier'],
      version: meta['version'],
      effectiveFrom: dateOrNull(meta['effective_from'], 'effective_from', sourceName),
      effectiveTo: dateOrNull(meta['effective_to'], 'effective_to', sourceName),
      sections,
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      throw new Error(`${sourceName}: ${z.prettifyError(error)}`, { cause: error });
    }
    throw error;
  }
}

/** Every `.md` under `dir`, recursively, sorted by path so the load order is stable. */
export async function loadPolicyDocuments(dir = POLICY_FIXTURES_DIR): Promise<SourceDocument[]> {
  const entries = await readdir(dir, { withFileTypes: true, recursive: true });
  const files = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.md') && entry.name !== 'README.md')
    .map((entry) => path.join(entry.parentPath, entry.name))
    .toSorted();
  return Promise.all(
    files.map(async (file) =>
      parsePolicyMarkdown(await readFile(file, 'utf8'), path.relative(dir, file)),
    ),
  );
}
