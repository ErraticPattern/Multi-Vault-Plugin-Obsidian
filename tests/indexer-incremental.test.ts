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

function harness(
  initial: IndexedFile[],
  scannedEntries: Array<{ vaultId: string; file: FileEntry }> = [],
  scanDelayMs = 0,
  failSave = false,
) {
  const parsedPaths: string[] = [];
  let saves = 0;
  let scanCalls = 0;
  const entries = new Map([
    ['ideas:Index.md', entry('ideas', 'Index.md')],
    ['medicine:Notes/Source.md', entry('medicine', 'Notes/Source.md')],
    ...scannedEntries.map(({ vaultId, file }) => [`${vaultId}:${file.relativePath}`, file] as const),
  ]);
  const scanner = {
    scanVaultAsync: async (vault: VaultConfig) => {
      scanCalls += 1;
      if (scanDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, scanDelayMs));
      return scannedEntries.filter((item) => item.vaultId === vault.id).map((item) => item.file);
    },
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
    saveIndex: async () => {
      saves += 1;
      if (failSave) throw new Error('cache unavailable');
    },
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
  return {
    indexer,
    parsedPaths,
    get saves() { return saves; },
    get scanCalls() { return scanCalls; },
  };
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

  it('does not publish in-memory mutations when cache persistence fails', async () => {
    const original = indexed('ideas', 'Source.md');
    const test = harness([original], [], 0, true);
    await test.indexer.initialize();

    await expect(test.indexer.applyMutations([
      { kind: 'remove', vaultId: 'ideas', relativePath: 'Source.md' },
    ])).rejects.toThrow('cache unavailable');

    expect(test.indexer.getIndexedFiles()).toEqual([original]);
  });
});

describe('Indexer.refreshIncremental', () => {
  it('parses only new or mtime/size-changed files and removes missing entries', async () => {
    const test = harness([
      indexed('ideas', 'Stable.md', 10, 100),
      indexed('ideas', 'Changed.md', 10, 100),
      indexed('ideas', 'Removed.md', 10, 100),
    ], [
      { vaultId: 'ideas', file: entry('ideas', 'Stable.md', 10, 100) },
      { vaultId: 'ideas', file: entry('ideas', 'Changed.md', 11, 100) },
      { vaultId: 'medicine', file: entry('medicine', 'New.md', 1, 1) },
    ]);
    await test.indexer.initialize();

    await test.indexer.refreshIncremental();

    expect(test.parsedPaths).toEqual(['ideas:Changed.md', 'medicine:New.md']);
    expect(test.indexer.getIndexedFiles().map((file) => file.id).sort()).toEqual([
      'ideas:Changed.md', 'ideas:Stable.md', 'medicine:New.md',
    ]);
    expect(test.saves).toBe(1);
  });

  it('allows a new refresh after the previous refresh settles', async () => {
    const test = harness([], [
      { vaultId: 'ideas', file: entry('ideas', 'A.md') },
    ]);
    await test.indexer.initialize();

    await test.indexer.refreshIncremental();
    await test.indexer.refreshIncremental();

    expect(test.scanCalls).toBe(4);
  });

  it('coalesces concurrent refresh callers', async () => {
    const test = harness([], [
      { vaultId: 'ideas', file: entry('ideas', 'A.md') },
      { vaultId: 'medicine', file: entry('medicine', 'B.md') },
    ], 10);
    await test.indexer.initialize();

    await Promise.all([
      test.indexer.refreshIncremental(),
      test.indexer.refreshIncremental(),
      test.indexer.refreshIncremental(),
    ]);

    expect(test.scanCalls).toBe(2);
    expect(test.saves).toBe(1);
  });
});
