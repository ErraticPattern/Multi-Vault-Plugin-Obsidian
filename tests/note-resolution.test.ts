import { describe, expect, it } from 'vitest';
import { resolveIndexedNote } from '../src/note-resolution';
import type { IndexedFile } from '../src/types';

const files = [
  { vaultName: 'ideas', relativePath: 'README.md', basename: 'README', extension: '.md' },
  { vaultName: 'ideas', relativePath: 'Lab/README.md', basename: 'README', extension: '.md' },
  { vaultName: 'ideas', relativePath: 'Notes/Unique.md', basename: 'Unique', extension: '.md' },
  { vaultName: 'medicine', relativePath: 'README.md', basename: 'README', extension: '.md' },
] as IndexedFile[];

describe('resolveIndexedNote', () => {
  it('resolves a unique basename case-insensitively', () => {
    expect(resolveIndexedNote(files, 'IDEAS', 'unique')).toMatchObject({
      kind: 'resolved', target: { relativePath: 'Notes/Unique.md' },
    });
  });

  it('resolves an exact extensionless relative path', () => {
    expect(resolveIndexedNote(files, 'ideas', 'Lab/README')).toMatchObject({
      kind: 'resolved', target: { relativePath: 'Lab/README.md' },
    });
  });

  it('resolves an explicitly rooted path when its basename is duplicated', () => {
    expect(resolveIndexedNote(files, 'ideas', '/README')).toMatchObject({
      kind: 'resolved', target: { relativePath: 'README.md' },
    });
  });

  it('returns every candidate for an ambiguous basename', () => {
    const result = resolveIndexedNote(files, 'ideas', 'README');
    expect(result.kind).toBe('ambiguous');
    if (result.kind === 'ambiguous') {
      expect(result.candidates.map((file) => file.relativePath)).toEqual([
        'Lab/README.md', 'README.md',
      ]);
    }
  });

  it('does not mix candidates from different vaults', () => {
    expect(resolveIndexedNote(files, 'medicine', 'README')).toMatchObject({
      kind: 'resolved', target: { relativePath: 'README.md' },
    });
  });

  it('returns missing instead of an arbitrary match', () => {
    expect(resolveIndexedNote(files, 'ideas', 'Absent')).toEqual({ kind: 'missing' });
  });
});
