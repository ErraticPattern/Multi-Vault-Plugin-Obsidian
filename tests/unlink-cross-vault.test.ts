import { describe, expect, it } from 'vitest';

import { protectedRanges, removeCrossVaultLinks, unlinkedText } from '../src/unlink-cross-vault';

const known = (vaultName: string) => ['hobbies', 'mathematics', 'medicine', 'ideas'].includes(vaultName);

describe('text left behind by a removed cross-vault link', () => {
  it('keeps the alias, which is what the sentence actually read', () => {
    expect(unlinkedText('[[As@hobbies|as]]', known)).toBe('as');
  });

  it('falls back to the note name when there is no alias', () => {
    expect(unlinkedText('[[math@mathematics]]', known)).toBe('math');
  });

  it('reads the original vault::note spelling too', () => {
    expect(unlinkedText('[[mathematics::Claude]]', known)).toBe('Claude');
    expect(unlinkedText('[[mathematics::Claude|him]]', known)).toBe('him');
  });

  it('drops the folder from a path-qualified target', () => {
    expect(unlinkedText('[[Notes/Norm@mathematics]]', known)).toBe('Norm');
    expect(unlinkedText('[[/Claude@mathematics]]', known)).toBe('Claude');
  });

  it('drops a subpath, keeping only the note name', () => {
    expect(unlinkedText('[[EEG@mathematics#Acquisition]]', known)).toBe('EEG');
  });

  it('leaves ordinary links alone', () => {
    expect(unlinkedText('[[Chemistry|chemistry]]', known)).toBeNull();
    expect(unlinkedText('[[joao@gmail.com]]', known)).toBeNull();
    expect(unlinkedText('[[Meeting@work]]', known)).toBeNull();
  });

  it('leaves embeds alone, since removing one would delete the content', () => {
    expect(unlinkedText('![[Figure@mathematics]]', known)).toBeNull();
  });

  it('treats an escaped pipe as part of the target, not an alias', () => {
    expect(unlinkedText('[[Norm@mathematics\\|n]]', known)).toBeNull();
  });

  it('falls back to the note name when the alias is empty', () => {
    expect(unlinkedText('[[math@mathematics|]]', known)).toBe('math');
  });
});

describe('regions where [[...]] is content rather than a link', () => {
  it('protects fenced code, inline code, formulas and frontmatter', () => {
    const content = '---\nsource: "[[A@hobbies]]"\n---\n\nText [[B@hobbies|b]]\n\n'
      + '```md\n[[C@hobbies|c]]\n```\n\nInline `[[D@hobbies|d]]`, math $x_{[[E@hobbies|e]]}$.';

    expect(removeCrossVaultLinks(content, known)).toEqual({
      text: '---\nsource: "[[A@hobbies]]"\n---\n\nText b\n\n'
        + '```md\n[[C@hobbies|c]]\n```\n\nInline `[[D@hobbies|d]]`, math $x_{[[E@hobbies|e]]}$.',
      removed: 1,
    });
  });

  it('treats a lone dollar or backtick as punctuation, not an opening delimiter', () => {
    expect(protectedRanges('costs $5 for [[A]]')).toEqual([]);
    expect(removeCrossVaultLinks('costs $5 for [[A@hobbies|a]]', known).text)
      .toBe('costs $5 for a');
  });
});

describe('removing every cross-vault link in a note', () => {
  it('restores the prose and leaves local links untouched', () => {
    const content = 'This vault serves [[As@hobbies|as]] [[The@hobbies|the]] storage of '
      + '[[Chemistry|chemistry]] knowledge.';

    expect(removeCrossVaultLinks(content, known)).toEqual({
      text: 'This vault serves as the storage of [[Chemistry|chemistry]] knowledge.',
      removed: 2,
    });
  });

  it('reaches links inside a table, which Obsidian itself does not index', () => {
    const content = '| Plugin | Purpose |\n| --- | --- |\n'
      + '| latex-suite | keybindings like [[vegetative state@ideas|VS]] Code |';

    expect(removeCrossVaultLinks(content, known)).toEqual({
      text: '| Plugin | Purpose |\n| --- | --- |\n| latex-suite | keybindings like VS Code |',
      removed: 1,
    });
  });

  it('reports nothing to do for a note without cross-vault links', () => {
    const content = 'Plain [[Chemistry]] note with $x@y$ and no cross-vault links.';

    expect(removeCrossVaultLinks(content, known)).toEqual({ text: content, removed: 0 });
  });

  it('handles several links on one line without disturbing the later ones', () => {
    expect(removeCrossVaultLinks('[[A@hobbies|a]] then [[B@hobbies|b]] then [[C@hobbies|c]]', known).text)
      .toBe('a then b then c');
  });
});
