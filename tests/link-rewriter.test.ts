import { describe, expect, it } from 'vitest';
import {
  applyTextEdits,
  rewriteWikilinkOriginal,
  splitLinkSubpath,
  StaleTextEditError,
} from '../src/migration/link-rewriter';

describe('rewriteWikilinkOriginal', () => {
  it('rewrites plain wikilinks', () => {
    expect(rewriteWikilinkOriginal('[[Zerotier]]', 'mathematics::Zerotier'))
      .toBe('[[mathematics::Zerotier]]');
  });

  it('preserves aliases, heading fragments, and block fragments', () => {
    expect(rewriteWikilinkOriginal(
      '[[Zerotier#Setup|network]]',
      'mathematics::Zerotier#Setup',
    )).toBe('[[mathematics::Zerotier#Setup|network]]');
    expect(rewriteWikilinkOriginal(
      '[[Zerotier#^block-id]]',
      'mathematics::Zerotier#^block-id',
    )).toBe('[[mathematics::Zerotier#^block-id]]');
  });

  it('preserves an alias containing an escaped pipe', () => {
    expect(rewriteWikilinkOriginal(
      String.raw`[[Zerotier|network\|VPN]]`,
      'mathematics::Zerotier',
    )).toBe(String.raw`[[mathematics::Zerotier|network\|VPN]]`);
  });

  it('rejects embeds and Markdown links', () => {
    expect(rewriteWikilinkOriginal('![[diagram.png]]', 'mathematics::diagram.png')).toBeNull();
    expect(rewriteWikilinkOriginal('[network](Zerotier.md)', 'mathematics::Zerotier')).toBeNull();
  });
});

describe('splitLinkSubpath', () => {
  it('separates heading and block subpaths', () => {
    expect(splitLinkSubpath('Zerotier#Setup')).toEqual({
      linkpath: 'Zerotier',
      subpath: '#Setup',
    });
    expect(splitLinkSubpath('Zerotier#^block-id')).toEqual({
      linkpath: 'Zerotier',
      subpath: '#^block-id',
    });
    expect(splitLinkSubpath('Zerotier')).toEqual({ linkpath: 'Zerotier', subpath: '' });
  });
});

describe('applyTextEdits', () => {
  it('applies multiple edits without shifting later offsets', () => {
    const content = 'A [[One]] B [[Two|2]] C';
    expect(applyTextEdits(content, [
      {
        startOffset: content.indexOf('[[One]]'),
        endOffset: content.indexOf('[[One]]') + '[[One]]'.length,
        expected: '[[One]]',
        replacement: '[[source::One]]',
      },
      {
        startOffset: content.indexOf('[[Two|2]]'),
        endOffset: content.indexOf('[[Two|2]]') + '[[Two|2]]'.length,
        expected: '[[Two|2]]',
        replacement: '[[source::Two|2]]',
      },
    ])).toBe('A [[source::One]] B [[source::Two|2]] C');
  });

  it('rejects stale expected text before changing content', () => {
    expect(() => applyTextEdits('A [[Changed]]', [{
      startOffset: 2,
      endOffset: 9,
      expected: '[[Old]]',
      replacement: '[[vault::Old]]',
    }])).toThrow(StaleTextEditError);
  });

  it('rejects overlapping edits', () => {
    expect(() => applyTextEdits('abcdef', [
      { startOffset: 1, endOffset: 4, expected: 'bcd', replacement: 'x' },
      { startOffset: 3, endOffset: 5, expected: 'de', replacement: 'y' },
    ])).toThrow(/overlap/i);
  });
});
