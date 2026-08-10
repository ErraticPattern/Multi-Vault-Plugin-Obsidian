import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  chooseCrossVaultNotePath,
  extensionlessMarkdownPath,
  listDestinationFolders,
  resolveDestinationPath,
  UnsafeDestinationPathError,
} from '../src/migration/destination-paths';

describe('destination paths', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'mvn-destination-'));
    for (const directory of [
      '.obsidian',
      '.git',
      '.hidden',
      'node_modules',
      'Notes',
      'Notes/Networks',
      'Attachments',
    ]) {
      mkdirSync(path.join(root, directory), { recursive: true });
    }
    try {
      symlinkSync(path.join(root, 'Notes'), path.join(root, 'linked-notes'), 'junction');
    } catch {
      // Creating symlinks may be unavailable in a restricted Windows session.
    }
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('lists root and safe folders without hidden, dependency, or symlink traversal', () => {
    expect(listDestinationFolders(root)).toEqual([
      '/',
      'Attachments',
      'Notes',
      'Notes/Networks',
    ]);
  });

  it('resolves a nested destination inside the selected vault', () => {
    expect(resolveDestinationPath(root, 'Notes/Networks', 'Zerotier.md')).toEqual({
      absolutePath: path.join(root, 'Notes', 'Networks', 'Zerotier.md'),
      relativePath: 'Notes/Networks/Zerotier.md',
    });
    expect(resolveDestinationPath(root, '/', 'Zerotier.md').relativePath).toBe('Zerotier.md');
  });

  it.each([
    '../outside',
    '..\\outside',
    '/absolute',
    'C:\\outside',
    'Notes/../../outside',
  ])('rejects unsafe folder %s', (folder) => {
    expect(() => resolveDestinationPath(root, folder, 'Zerotier.md'))
      .toThrow(UnsafeDestinationPathError);
  });

  it('rejects unsafe filenames', () => {
    expect(() => resolveDestinationPath(root, 'Notes', '../Zerotier.md'))
      .toThrow(UnsafeDestinationPathError);
    expect(() => resolveDestinationPath(root, 'Notes', 'Nested/Zerotier.md'))
      .toThrow(UnsafeDestinationPathError);
  });
});

describe('cross-vault note references', () => {
  it('uses a basename when it is unique', () => {
    expect(chooseCrossVaultNotePath('Notes/Zerotier.md', [
      { relativePath: 'Notes/Zerotier.md', basename: 'Zerotier' },
    ])).toBe('Zerotier');
  });

  it('uses an extensionless relative path for duplicate basenames', () => {
    expect(chooseCrossVaultNotePath('Notes/Zerotier.md', [
      { relativePath: 'Notes/Zerotier.md', basename: 'Zerotier' },
      { relativePath: 'Archive/Zerotier.md', basename: 'Zerotier' },
    ])).toBe('Notes/Zerotier');
  });

  it('treats basename collisions case-insensitively', () => {
    expect(chooseCrossVaultNotePath('Notes/Zerotier.md', [
      { relativePath: 'Archive/ZEROTIER.md', basename: 'ZEROTIER' },
    ])).toBe('Notes/Zerotier');
  });

  it('removes only a final Markdown extension', () => {
    expect(extensionlessMarkdownPath('Notes/file.name.md')).toBe('Notes/file.name');
    expect(extensionlessMarkdownPath('Notes/file.name')).toBe('Notes/file.name');
  });
});
