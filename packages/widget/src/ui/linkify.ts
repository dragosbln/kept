// Message text → DOM nodes. Everything becomes text nodes; the only
// elements ever built from message content are <a> tags around substrings
// that re-parse as strict http(s) URLs, so markup in agent or customer text
// renders inert. The widget's XSS discipline lives in this file — nothing
// else may put dynamic content anywhere but textContent.
//
// Linkification exists for a product reason: WISMO answers carry carrier
// tracking links, and a tracking link you cannot click is a support ticket.

const URL_PATTERN = /https?:\/\/[^\s<>"'`]+/g;
const TRAILING_PUNCTUATION = /[.,;:!?…]+$/;

export function renderMessageText(text: string): DocumentFragment {
  const fragment = document.createDocumentFragment();
  let cursor = 0;
  for (const match of text.matchAll(URL_PATTERN)) {
    const candidate = trimTrailing(match[0]);
    const href = toSafeHref(candidate);
    // An unsafe or unparseable candidate is left alone; it flows into the
    // following text slice untouched.
    if (href === null) continue;
    fragment.append(document.createTextNode(text.slice(cursor, match.index)));
    const anchor = document.createElement('a');
    anchor.href = href;
    anchor.textContent = candidate;
    anchor.target = '_blank';
    anchor.rel = 'noopener noreferrer';
    fragment.append(anchor);
    cursor = match.index + candidate.length;
  }
  fragment.append(document.createTextNode(text.slice(cursor)));
  return fragment;
}

/**
 * Sentence punctuation after a URL is prose, not address: "see https://x.dev."
 * links to https://x.dev. A trailing ")" is kept only while the URL itself
 * has an unmatched "(" — "(see https://x.dev/a_(b))" links to .../a_(b).
 */
function trimTrailing(raw: string): string {
  let candidate = raw;
  for (;;) {
    const trimmed = candidate.replace(TRAILING_PUNCTUATION, '');
    if (trimmed.endsWith(')') && !hasOpenParenFor(trimmed)) {
      candidate = trimmed.slice(0, -1);
      continue;
    }
    if (trimmed === candidate) return candidate;
    candidate = trimmed;
  }
}

function hasOpenParenFor(candidate: string): boolean {
  let depth = 0;
  for (const char of candidate) {
    if (char === '(') depth += 1;
    else if (char === ')') depth -= 1;
  }
  return depth >= 0;
}

function toSafeHref(candidate: string): string | null {
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return null;
  }
  return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
}
