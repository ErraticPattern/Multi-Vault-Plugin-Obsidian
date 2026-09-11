import { describe, expect, it } from 'vitest';
import { parseWikilinkOccurrences } from '../src/unresolved-links/unresolved-link-parser';

describe('unresolved wikilink parser', () => {
  it('parses links, embeds, aliases, subpaths, and exact offsets', () => {
    const content = 'See [[fusion]], ![[fusion#Rate|chart]], and [[Topics/fusion^block]].';
    const found = parseWikilinkOccurrences(content);
    expect(found.map(item => ({ original: item.original, embed: item.embed, linkpath: item.linkpath, subpath: item.subpath, alias: item.alias }))).toEqual([
      { original: '[[fusion]]', embed: false, linkpath: 'fusion', subpath: '', alias: '' },
      { original: '![[fusion#Rate|chart]]', embed: true, linkpath: 'fusion', subpath: '#Rate', alias: '|chart' },
      { original: '[[Topics/fusion^block]]', embed: false, linkpath: 'Topics/fusion', subpath: '^block', alias: '' },
    ]);
    for (const item of found) expect(content.slice(item.startOffset, item.endOffset)).toBe(item.original);
  });

  it('excludes fenced code, inline code, escaped links, and existing cross-vault links', () => {
    const content = '---\nalias: [[frontmatter]]\n---\n`[[inline]]`\n~~~~md\n[[fenced]]\n~~~~\n$[[formula]]$ \\[[escaped]] [[fusion@mathematics]] [[mathematics::fusion]] [[real]]';
    expect(parseWikilinkOccurrences(content).map(item => item.linkpath)).toEqual(['real']);
  });
});
