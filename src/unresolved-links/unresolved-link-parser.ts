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

function splitInner(inner: string): { linkpath: string; subpath: string; alias: string } {
  const aliasIndex = inner.indexOf('|');
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
  const result: WikilinkOccurrence[] = [];
  let fenced = false;
  let inline = false;
  for (let index = 0; index < content.length;) {
    if ((index === 0 || content[index - 1] === '\n') && content.startsWith('```', index)) {
      fenced = !fenced;
      index += 3;
      continue;
    }
    if (!fenced && content[index] === '`' && !escapedAt(content, index)) {
      inline = !inline;
      index++;
      continue;
    }
    if (fenced || inline) { index++; continue; }
    const embed = content[index] === '!' && content.startsWith('[[', index + 1);
    const open = embed ? index + 1 : index;
    if (!content.startsWith('[[', open) || escapedAt(content, open)) { index++; continue; }
    const close = content.indexOf(']]', open + 2);
    if (close < 0) break;
    const original = content.slice(index, close + 2);
    const parsed = splitInner(content.slice(open + 2, close));
    if (parsed.linkpath && !parsed.linkpath.includes('@') && !parsed.linkpath.includes('::')) {
      result.push({ startOffset: index, endOffset: close + 2, original, embed, ...parsed });
    }
    index = close + 2;
  }
  return result;
}
