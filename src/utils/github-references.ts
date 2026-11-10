/** An issue or pull request mentioned in some GitHub text. */
export interface GithubReference {
  /** `owner/repo`; the repository the text lives in when written as a bare `#12`. */
  repository: string;
  number: number;
  /** Written after a closing keyword ("Fixes #12"), so merging closes it. */
  closing: boolean;
}

const CLOSING_KEYWORD =
  /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s*:?\s+((?:[\w.-]+\/[\w.-]+)?#\d+)/gi;
// Not preceded by a word, URL or path character, so `a.test/b#3` is not a reference.
const ANY_REFERENCE = /(?<![\w&/#.:@-])((?:[\w.-]+\/[\w.-]+)?#\d+)(?!\w)/g;
const REFERENCE_PARTS = /^(?:([\w.-]+\/[\w.-]+))?#(\d+)$/;

function toReference(
  token: string,
  repository: string,
  closing: boolean,
): GithubReference | null {
  const parts = REFERENCE_PARTS.exec(token);
  if (!parts) return null;
  const number = Number(parts[2]);
  return number > 0
    ? { repository: parts[1] ?? repository, number, closing }
    : null;
}

/**
 * Issues and pull requests a description refers to, closing references first.
 * Fenced and inline code is ignored, so a `#1` in a snippet is not a link.
 */
export function parseGithubReferences(
  text: string | null | undefined,
  repository: string,
  self?: number,
): GithubReference[] {
  if (!text) return [];
  const prose = text.replace(/```[\s\S]*?```/g, " ").replace(/`[^`\n]*`/g, " ");
  const found = new Map<string, GithubReference>();
  const add = (token: string, closing: boolean) => {
    const ref = toReference(token, repository, closing);
    if (!ref) return;
    const sameItem =
      ref.number === self &&
      ref.repository.toLowerCase() === repository.toLowerCase();
    if (sameItem) return;
    const key = `${ref.repository.toLowerCase()}#${ref.number}`;
    const existing = found.get(key);
    if (!existing || (closing && !existing.closing)) found.set(key, ref);
  };
  for (const match of prose.matchAll(CLOSING_KEYWORD)) add(match[1], true);
  for (const match of prose.matchAll(ANY_REFERENCE)) add(match[1], false);
  return [...found.values()].sort(
    (a, b) => Number(b.closing) - Number(a.closing),
  );
}
