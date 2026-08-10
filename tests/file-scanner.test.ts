import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { FileScanner } from '../src/indexer/file-scanner';
import type { VaultConfig } from '../src/types';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(): Promise<{ root: string; vault: VaultConfig }> {
  const root = mkdtempSync(path.join(tmpdir(), 'mvn-scanner-'));
  roots.push(root);
  for (const folder of ['Allowed', 'Excluded', 'Other', '.obsidian']) {
    await mkdir(path.join(root, folder), { recursive: true });
    await writeFile(path.join(root, folder, 'Note.md'), folder);
  }
  return {
    root,
    vault: {
      id: 'test', name: 'test', path: root, enabled: true,
      includePatterns: ['Allowed'], excludePatterns: ['Excluded'],
    },
  };
}

describe('FileScanner.scanFileAsync', () => {
  it('uses the same include and exclude rules as full-vault scanning', async () => {
    const { vault } = await fixture();
    const scanner = new FileScanner([]);

    expect(await scanner.scanFileAsync(vault, 'Allowed/Note.md')).toMatchObject({
      relativePath: 'Allowed/Note.md',
    });
    expect(await scanner.scanFileAsync(vault, 'Excluded/Note.md')).toBeNull();
    expect(await scanner.scanFileAsync(vault, 'Other/Note.md')).toBeNull();
    expect(await scanner.scanFileAsync(vault, '.obsidian/Note.md')).toBeNull();
  });

  it('does not prune ancestors of a nested include match', async () => {
    const { root, vault } = await fixture();
    await mkdir(path.join(root, 'Notes', 'Important-2026'), { recursive: true });
    await writeFile(path.join(root, 'Notes', 'Important-2026', 'Nested.md'), 'Nested');
    vault.includePatterns = ['Important-2026'];
    vault.excludePatterns = [];
    const scanner = new FileScanner([]);

    const scanned = await scanner.scanVaultAsync(vault);

    expect(scanned.map((file) => file.relativePath)).toEqual([
      'Notes/Important-2026/Nested.md',
    ]);
  });

  it('applies global excludes to direct and full scans', async () => {
    const { vault } = await fixture();
    vault.includePatterns = [];
    vault.excludePatterns = [];
    const scanner = new FileScanner(['Other']);

    expect(await scanner.scanFileAsync(vault, 'Other/Note.md')).toBeNull();
    const scanned = await scanner.scanVaultAsync(vault);
    expect(scanned.map((file) => file.relativePath).sort()).toEqual([
      'Allowed/Note.md', 'Excluded/Note.md',
    ]);
  });
});
