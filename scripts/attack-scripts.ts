// The hand-written adversarial scripts in scripts/attacks/: one JSON file
// per script, validated on load. Shared by the in-process attack driver
// (attack.ts) and the HTTP scam demo (demo-scam.ts), which replay the same
// conversations against different hosts.

import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

export const ATTACKS_DIR = path.join(import.meta.dirname, 'attacks');
export const REPO_ROOT = path.join(import.meta.dirname, '..');

export type AttackScript = {
  id: string;
  file: string;
  title?: string;
  orderId?: string;
  breakCondition?: string;
  prediction?: string;
  /** One inner array per conversation, one string per customer turn. */
  conversations: string[][];
};

const isTurn = (turn: unknown): turn is string => typeof turn === 'string' && turn.trim() !== '';
const isConversation = (conv: unknown): conv is string[] =>
  Array.isArray(conv) && conv.length > 0 && conv.every(isTurn);

function parseScript(raw: unknown, file: string): AttackScript {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error(`${file}: not a JSON object`);
  }
  const obj = raw as Record<string, unknown>;
  const id = obj['id'];
  if (typeof id !== 'string' || id.length === 0) {
    throw new Error(`${file}: "id" must be a non-empty string`);
  }
  const conversations = obj['conversations'];
  if (!Array.isArray(conversations) || conversations.length === 0) {
    throw new Error(`${file}: "conversations" must be a non-empty array`);
  }
  if (!conversations.every(isConversation)) {
    throw new Error(`${file}: every conversation must be a non-empty array of non-empty strings`);
  }
  const text = (key: string): string | undefined =>
    typeof obj[key] === 'string' ? (obj[key] as string) : undefined;
  const title = text('title');
  const orderId = text('orderId');
  const breakCondition = text('breakCondition');
  const prediction = text('prediction');
  return {
    id,
    file: path.relative(REPO_ROOT, file),
    conversations,
    ...(title === undefined ? {} : { title }),
    ...(orderId === undefined ? {} : { orderId }),
    ...(breakCondition === undefined ? {} : { breakCondition }),
    ...(prediction === undefined ? {} : { prediction }),
  };
}

/** A file in scripts/attacks/ by name (without .json), or any path. */
export async function loadScript(nameOrPath: string): Promise<AttackScript> {
  const candidates = [
    path.resolve(nameOrPath),
    path.join(ATTACKS_DIR, `${nameOrPath}.json`),
    path.join(ATTACKS_DIR, nameOrPath),
  ];
  const file = candidates.find((candidate) => existsSync(candidate));
  if (!file) {
    throw new Error(
      `no script "${nameOrPath}" (looked in ${path.relative(REPO_ROOT, ATTACKS_DIR)}/)`,
    );
  }
  return parseScript(JSON.parse(await readFile(file, 'utf8')), file);
}

/** Every script in scripts/attacks/, in id order. */
export async function loadAllScripts(): Promise<AttackScript[]> {
  const files = (await readdir(ATTACKS_DIR)).filter((name) => name.endsWith('.json'));
  const scripts = await Promise.all(files.map((name) => loadScript(path.join(ATTACKS_DIR, name))));
  return scripts.toSorted((a, b) => a.id.localeCompare(b.id, 'en', { numeric: true }));
}
