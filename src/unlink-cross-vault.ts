import { parseCrossVaultTarget, type CrossVaultRef } from './cross-vault-syntax';

export interface UnlinkResult {
  text: string;
  /** Links actually turned back into text. */
  removed: number;
}

/**
 * Regions where `[[...]]` is content rather than a link.
 *
 * Obsidian's own metadata cache would answer this, but it does not see a link
 * whose alias pipe sits in a table row, and those are exactly the links this
 * command exists to clean up. Scanning the source finds every one of them, so
 * the cost is having to recognise code and formulas here instead.
 */
export function protectedRanges(text: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];

  if (text.startsWith('---\n') || text.startsWith('---\r\n')) {
    const close = /\r?\n---(\r?\n|$)/.exec(text.slice(3));
    if (close) ranges.push([0, 3 + close.index + close[0].length]);
  }

  for (let index = 0; index < text.length; index += 1) {
    const atLineStart = index === 0 || text[index - 1] === '\n';
    const fence = atLineStart ? /^(?:```+|~~~+)/.exec(text.slice(index)) : null;
    if (fence) {
      const close = text.indexOf(`\n${fence[0]}`, index + fence[0].length);
      const end = close === -1
        ? text.length
        : (text.indexOf('\n', close + 1) + 1 || text.length);
      ranges.push([index, end]);
      index = end - 1;
      continue;
    }

    let delimiter = '';
    if (text.startsWith('$$', index)) delimiter = '$$';
    else if (text[index] === '$') delimiter = '$';
    else if (text[index] === '`') delimiter = /^`+/.exec(text.slice(index))![0];
    if (!delimiter) continue;

    const close = text.indexOf(delimiter, index + delimiter.length);
    // An unclosed delimiter is ordinary punctuation, so it protects nothing.
    if (close === -1) continue;
    ranges.push([index, close + delimiter.length]);
    index = close + delimiter.length - 1;
  }

  return ranges;
}

/** Splits an alias off a wikilink body, ignoring a `\|` escaped for a table. */
function aliasSeparator(inner: string): number {
  for (let index = 0; index < inner.length; index += 1) {
    if (inner[index] !== '|') continue;
    let backslashes = 0;
    for (let cursor = index - 1; cursor >= 0 && inner[cursor] === '\\'; cursor -= 1) {
      backslashes += 1;
    }
    if (backslashes % 2 === 0) return index;
  }
  return -1;
}

/** The bare note name a reader sees when a link carries no alias. */
function noteNameOf(reference: CrossVaultRef): string {
  const segments = reference.noteName.split('/').filter((segment) => segment.length > 0);
  return segments[segments.length - 1] ?? reference.noteName;
}

/**
 * The text a cross-vault link leaves behind once the link is removed, or null
 * when this is not a cross-vault link and must be left alone.
 *
 * The alias wins, because the alias is what the sentence actually read before
 * the link was made: `[[As@hobbies|as]]` came from the word "as", and restoring
 * "As" instead would change the prose.
 */
export function unlinkedText(
  original: string,
  isKnownVault: (vaultName: string) => boolean,
): string | null {
  if (original.startsWith('![[') || !original.startsWith('[[') || !original.endsWith(']]')) {
    return null;
  }

  const inner = original.slice(2, -2);
  const separator = aliasSeparator(inner);
  const target = (separator === -1 ? inner : inner.slice(0, separator)).trim();

  const reference = parseCrossVaultTarget(target, isKnownVault);
  if (!reference) return null;

  const alias = separator === -1 ? '' : inner.slice(separator + 1).trim();
  return alias.length > 0 ? alias : noteNameOf(reference);
}

const WIKILINK = /!?\[\[[^[\]\n]+\]\]/g;

/** Rewrites every cross-vault link in `content` back to the text it displays. */
export function removeCrossVaultLinks(
  content: string,
  isKnownVault: (vaultName: string) => boolean,
): UnlinkResult {
  const ranges = protectedRanges(content);
  const isProtected = (index: number) => ranges.some(([start, end]) => index >= start && index < end);

  let removed = 0;
  const text = content.replace(WIKILINK, (original, offset: number) => {
    if (isProtected(offset)) return original;
    const replacement = unlinkedText(original, isKnownVault);
    if (replacement === null) return original;
    removed += 1;
    return replacement;
  });

  return { text, removed };
}
