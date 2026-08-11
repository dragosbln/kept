#!/usr/bin/env node
// Enforces ADR 0001: Langfuse is a sink for humans, not a source for machines.
//
// The eval suite and the CI fault-toggle matrix must run with Postgres
// alone. If @kept-hq/evals ever grows a Langfuse dependency, an import, or a
// LANGFUSE_* config read, the matrix has quietly acquired a dependency on an
// eventually-consistent ingestion pipeline — and reds stop meaning "the
// agent regressed".
//
// This covers the mechanically checkable half of the rule. @kept-hq/core is
// not scanned: core legitimately imports the Langfuse SDK to *export*, and
// the ban there is on the read surface specifically. Tighten this once the
// exporter module exists.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Packages that must not know Langfuse exists, at all. */
const SEALED_PACKAGES = ['packages/evals'];

const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.mjs', '.cjs']);
const SKIP_DIRECTORIES = new Set(['node_modules', 'dist', '.turbo', 'coverage']);

const IMPORT_SPECIFIER = /(?:\bfrom\s*|\brequire\(\s*|\bimport\(\s*)['"]([^'"]+)['"]/g;
const LANGFUSE_MODULE = /^(?:@langfuse\/|langfuse(?:$|[/-]))/;
const LANGFUSE_ENV = /\bLANGFUSE_[A-Z0-9_]+/g;

function* walk(dir) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (SKIP_DIRECTORIES.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      yield* walk(full);
    } else if (SOURCE_EXTENSIONS.has(entry.slice(entry.lastIndexOf('.')))) {
      yield full;
    }
  }
}

const violations = [];

for (const pkg of SEALED_PACKAGES) {
  const pkgDir = join(ROOT, pkg);

  // 1. Declared dependencies.
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'));
  } catch {
    violations.push({ file: `${pkg}/package.json`, line: 0, detail: 'package.json unreadable' });
    continue;
  }
  for (const field of ['dependencies', 'devDependencies', 'peerDependencies']) {
    for (const name of Object.keys(manifest[field] ?? {})) {
      if (LANGFUSE_MODULE.test(name)) {
        violations.push({
          file: `${pkg}/package.json`,
          line: 0,
          detail: `${field} declares "${name}"`,
        });
      }
    }
  }

  // 2. Imports and config reads in source.
  for (const file of walk(pkgDir)) {
    const rel = relative(ROOT, file);
    const lines = readFileSync(file, 'utf8').split('\n');

    lines.forEach((text, index) => {
      IMPORT_SPECIFIER.lastIndex = 0;
      let match;
      while ((match = IMPORT_SPECIFIER.exec(text)) !== null) {
        if (LANGFUSE_MODULE.test(match[1])) {
          violations.push({ file: rel, line: index + 1, detail: `imports "${match[1]}"` });
        }
      }

      LANGFUSE_ENV.lastIndex = 0;
      const envMatch = LANGFUSE_ENV.exec(text);
      if (envMatch) {
        violations.push({ file: rel, line: index + 1, detail: `reads ${envMatch[0]}` });
      }
    });
  }
}

if (violations.length > 0) {
  console.error('\nADR 0001 violated — Langfuse is a sink for humans, not a source for machines.');
  console.error('The eval suite must run on Postgres alone.\n');
  for (const { file, line, detail } of violations) {
    console.error(`  ${file}${line ? `:${line}` : ''} — ${detail}`);
  }
  console.error('\nExporter coverage belongs in the one smoke test outside the eval matrix.');
  console.error('See docs/decisions/0001-eval-assertions-read-the-in-process-trace.md\n');
  process.exit(1);
}

console.log(`eval boundary intact (${SEALED_PACKAGES.join(', ')} free of Langfuse)`);
