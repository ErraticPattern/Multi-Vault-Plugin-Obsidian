import { protectedRanges } from '../unlink-cross-vault';

export interface WikilinkOccurrence {
  startOffset: number;
  endOffset: number;
  original: string;
  embed: boolean;
  linkpath: string;
  subpath: string;
  alias: string;
}

function escapedAt(content: string, index: number): boolean {
  let slashes = 0;
  for (let cursor = index - 1; cursor >= 0 && content[cursor] === '\\'; cursor--) slashes++;
  return slashes % 2 === 1;
}

function aliasSeparator(inner: string): number {
  for (let index = 0; index < inner.length; index++) {
    if (inner[index] !== '|') continue;
    let slashes = 0;
    for (let cursor = index - 1; cursor >= 0 && inner[cursor] === '\\'; cursor--) slashes++;
    if (slashes % 2 === 0) return index;
  }
  return -1;
}

function splitInner(inner: string): { linkpath: string; subpath: string; alias: string } {
  const aliasIndex = aliasSeparator(inner);
  const target = aliasIndex < 0 ? inner : inner.slice(0, aliasIndex);
  const alias = aliasIndex < 0 ? '' : inner.slice(aliasIndex);
  const hash = target.indexOf('#');
  const block = target.indexOf('^');
  const candidates = [hash, block].filter(index => index >= 0);
  const subpathIndex = candidates.length ? Math.min(...candidates) : -1;
  return {
    linkpath: (subpathIndex < 0 ? target : target.slice(0, subpathIndex)).trim().replace(/\.md$/i, ''),
    subpath: subpathIndex < 0 ? '' : target.slice(subpathIndex),
    alias,
  };
}

export function parseWikilinkOccurrences(content: string): WikilinkOccurrence[] {
  const ranges = protectedRanges(content);
  const isProtected = (index: number): boolean => ranges.some(([start, end]) => index >= start && index < end);
  const result: WikilinkOccurrence[] = [];
  const pattern = /!?\[\[[^[\]\n]+\]\]/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(content)) !== null) {
    const original = match[0];
    const embed = original.startsWith('!');
    const open = match.index + (embed ? 1 : 0);
    if (isProtected(match.index) || escapedAt(content, open)) continue;
    const parsed = splitInner(original.slice(embed ? 3 : 2, -2));
    if (parsed.linkpath && !parsed.linkpath.includes('@') && !parsed.linkpath.includes('::')) {
      result.push({
        startOffset: match.index,
        endOffset: match.index + original.length,
        original,
        embed,
        ...parsed,
      });
    }
  }
  return result;
}
