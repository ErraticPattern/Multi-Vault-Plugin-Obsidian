import { describe, expect, it } from 'vitest';
import { Indexer } from '../src/indexer/indexer';
import type { FileEntry } from '../src/indexer/file-scanner';
import type { IndexedFile, MultiVaultSettings, VaultConfig } from '../src/types';

const vaults: VaultConfig[] = [
  { id: 'ideas', name: 'ideas', path: 'C:/vaults/ideas', enabled: true },
  { id: 'medicine', name: 'medicine', path: 'C:/vaults/medicine', enabled: true },
];

const settings: MultiVaultSettings = {
  vaults,
  indexOptions: {
    maxPreviewChars: 1000,
    autoRefreshOnStartup: true,
    globalExcludePatterns: [],
    storeSnippetsInCache: true,
  },
  savedSearches: [], pinnedFiles: [], showCrossVaultBadge: true, useVaultColorForLinks: false,
};

function indexed(vaultId: string, relativePath: string, mtime = 1, size = 1): IndexedFile {
  const vault = vaults.find((item) => item.id === vaultId)!;
  const basename = relativePath.split('/').pop()!.replace(/\.md$/i, '');
  return {
    id: `${vaultId}:${relativePath}`, vaultId, vaultName: vault.name,
    absolutePath: `${vault.path}/${relativePath}`, relativePath, basename,
    extension: '.md', mtime, size,
  };
}

function entry(vaultId: string, relativePath: string, mtime = 2, size = 2): FileEntry {
  const file = indexed(vaultId, relativePath, mtime, size);
  return {
    absolutePath: file.absolutePath, relativePath, basename: file.basename,
    extension: '.md', mtime, size,
  };
}

function harness(initial: IndexedFile[]) {
  const parsedPaths: string[] = [];
  let saves = 0;
  const entries = new Map([
    ['ideas:Index.md', entry('ideas', 'Index.md')],
    ['medicine:Notes/Source.md', entry('medicine', 'Notes/Source.md')],
  ]);
  const scanner = {
    scanVaultAsync: async () => [],
    scanFileAsync: async (vault: VaultConfig, relativePath: string) =>
      entries.get(`${vault.id}:${relativePath}`) ?? null,
  };
  const parser = {
    parseMarkdownFileAsync: async (file: FileEntry, vault: VaultConfig) => {
      parsedPaths.push(`${vault.id}:${file.relativePath}`);
      return indexed(vault.id, file.relativePath, file.mtime, file.size);
    },
  };
  const store = {
    loadIndex: async () => initial,
    saveIndex: async () => { saves += 1; },
    clearIndex: async () => undefined,
  };
  const registry = {
    getVaultById: (id: string) => vaults.find((vault) => vault.id === id),
    getEnabledVaults: () => vaults,
  };
  const indexer = new Indexer({} as never, registry as never, settings, {
    scanner: scanner as never,
    parser: parser as never,
    store: store as never,
  });
  return { indexer, parsedPaths, get saves() { return saves; } };
}

describe('Indexer.applyMutations', () => {
  it('reparses deduplicated upserts, removes deleted paths, and saves once', async () => {
    const test = harness([
      indexed('ideas', 'Index.md'),
      indexed('ideas', 'Source.md'),
    ]);
    await test.indexer.initialize();

    await test.indexer.applyMutations([
      { kind: 'upsert', vaultId: 'ideas', relativePath: 'Index.md' },
      { kind: 'upsert', vaultId: 'ideas', relativePath: 'Index.md' },
      { kind: 'remove', vaultId: 'ideas', relativePath: 'Source.md' },
      { kind: 'upsert', vaultId: 'medicine', relativePath: 'Notes/Source.md' },
    ]);

    expect(test.parsedPaths).toEqual(['ideas:Index.md', 'medicine:Notes/Source.md']);
    expect(test.saves).toBe(1);
    expect(test.indexer.getIndexedFiles().map((file) => file.id).sort()).toEqual([
      'ideas:Index.md', 'medicine:Notes/Source.md',
    ]);
  });
});
