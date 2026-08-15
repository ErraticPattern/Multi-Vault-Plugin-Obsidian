import { describe, expect, it } from 'vitest';

import { noteNameBeforeAt, suggestionsFor } from '../src/cross-vault-suggest';
import type { IndexedFile } from '../src/types';

function file(vaultId: string, relativePath: string, extension = 'md'): IndexedFile {
  const basename = relativePath.split('/').pop()!.replace(/\.[^.]+$/, '');
  return {
    id: `${vaultId}:${relativePath}`,
    vaultId,
    vaultName: vaultId,
    absolutePath: `C:/vaults/${vaultId}/${relativePath}`,
    relativePath,
    basename,
    extension,
    mtime: 0,
    size: 0,
  };
}

describe('finding the note name before @', () => {
  // In plain text the name is only as long as a real note name; the suggester
  // asks the index, so the tests state which names exist.
  const known = (name: string) => ['Claude', 'Free Energy Principle', 'me'].includes(name);

  it('reads a plain-text name', () => {
    expect(noteNameBeforeAt('I read about Claude@', known)).toEqual({ name: 'Claude', startIndex: 13 });
  });

  it('reads a name inside an unfinished wikilink', () => {
    expect(noteNameBeforeAt('See [[Claude@', known)).toEqual({ name: 'Claude', startIndex: 4 });
  });

  it('keeps multi-word names together', () => {
    expect(noteNameBeforeAt('About Free Energy Principle@', known)?.name).toBe('Free Energy Principle');
  });

  it('offers nothing when no trailing phrase names a note', () => {
    expect(noteNameBeforeAt('I read about something else@', known)).toBeNull();
  });

  it('ignores anything that is not an @ at the caret', () => {
    expect(noteNameBeforeAt('Claude', known)).toBeNull();
    expect(noteNameBeforeAt('Claude@mathematics', known)).toBeNull();
  });

  it('ignores a second @, so addresses are left alone', () => {
    expect(noteNameBeforeAt('joao@gmail.com@', known)).toBeNull();
  });

  it('ignores an @ with no name in front of it', () => {
    expect(noteNameBeforeAt('@', known)).toBeNull();
    expect(noteNameBeforeAt('Write to @', known)).toBeNull();
    expect(noteNameBeforeAt('See [[@', known)).toBeNull();
  });

  it('ignores the alias half of a wikilink', () => {
    expect(noteNameBeforeAt('See [[Claude|the model@', known)).toBeNull();
  });

  it('ignores a wikilink that is already closed', () => {
    expect(noteNameBeforeAt('See [[Claude]] and mail me@', known)?.name).toBe('me');
  });
});

describe('suggesting notes from other vaults', () => {
  const files = [
    file('mathematics', 'Glossary/Claude.md'),
    file('medicine', 'Claude.md'),
    file('ideas', 'Claude.md'),
    file('hobbies', 'Claude.png', 'png'),
  ];

  it('offers the note from every other vault', () => {
    const suggestions = suggestionsFor('Claude', files, 'ideas');

    expect(suggestions.map((suggestion) => suggestion.vaultName)).toEqual(['mathematics', 'medicine']);
    expect(suggestions[0].noteReference).toBe('Claude');
  });

  it('never offers the current vault, which needs no cross-vault link', () => {
    expect(suggestionsFor('Claude', files, 'mathematics').map((s) => s.vaultName)).toEqual(['medicine', 'ideas']);
  });

  it('ignores non-markdown files', () => {
    expect(suggestionsFor('Claude', files, 'ideas').some((s) => s.vaultName === 'hobbies')).toBe(false);
  });

  it('qualifies the reference with a path when one vault holds duplicates', () => {
    const duplicates = [
      file('medicine', 'Notes/Claude.md'),
      file('medicine', 'Archive/Claude.md'),
    ];

    expect(suggestionsFor('Claude', duplicates, 'ideas').map((s) => s.noteReference))
      .toEqual(['Notes/Claude', 'Archive/Claude']);
  });

  it('qualifies a duplicate sitting at the vault root with a leading slash', () => {
    const duplicates = [
      file('medicine', 'Claude.md'),
      file('medicine', 'Notes/Claude.md'),
    ];

    expect(suggestionsFor('Claude', duplicates, 'ideas')[0].noteReference).toBe('/Claude');
  });

  it('matches case-insensitively but returns nothing for an empty query', () => {
    expect(suggestionsFor('claude', files, 'ideas')).toHaveLength(2);
    expect(suggestionsFor('   ', files, 'ideas')).toEqual([]);
  });
});
