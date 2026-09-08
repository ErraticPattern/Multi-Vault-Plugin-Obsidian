import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { discoverObsidianVaults } from '../src/obsidian-vault-discovery';
import { VaultRegistry } from '../src/vault-registry';
import { LocalVaultPathStore } from '../src/local-vault-path-store';
import { IndexStore } from '../src/indexer/index-store';

let root = '';
afterEach(() => rmSync(root, { recursive: true, force: true }));

it('migrates synced Windows settings and cache onto Flatpak Linux paths idempotently', async () => {
  root = mkdtempSync(path.join(tmpdir(), 'mvn-portable-e2e-'));
  const ideas = path.join(root, 'obsidian', 'ideas');
  mkdirSync(path.join(ideas, '.obsidian'), { recursive: true });
  const registryPath = path.join(root, '.var/app/md.obsidian.Obsidian/config/obsidian/obsidian.json');
  mkdirSync(path.dirname(registryPath), { recursive: true });
  writeFileSync(registryPath, JSON.stringify({ vaults: { localIdeas: { path: ideas } } }));
  const discovered = discoverObsidianVaults([registryPath], { platform: 'linux', env: {}, home: root, configDirName: '.obsidian', logError: () => undefined });
  const app = { vault: { configDir: '.obsidian', adapter: { getBasePath: () => ideas } } } as never;
  const localPaths = new LocalVaultPathStore(path.join(path.dirname(registryPath), 'multi-vault-navigator.json'));
  const settings = { vaults: [
    { id: 'windowsIdeas', name: 'ideas', path: 'C:\\Users\\joaop\\obsidian\\ideas', enabled: true },
    { id: 'linuxDuplicate', name: 'ideas', path: ideas, enabled: true },
    { id: 'remoteMedicine', name: 'medicine', path: 'C:\\Users\\joaop\\obsidian\\medicine', enabled: true },
  ] } as never;
  const registry = new VaultRegistry(app, settings, { platform: 'linux', env: {}, home: root, localPaths, discoveredVaults: discovered, generateId: () => 'generated' });
  expect(registry.getVaults()).toHaveLength(2);
  expect(registry.getVaultById('windowsIdeas')).toMatchObject({ available: true, path: ideas });
  expect(registry.getVaultById('remoteMedicine')).toMatchObject({ available: false });

  let cache = JSON.stringify({ version: 2, generatedAt: '', files: [{ id: 'one', vaultId: 'windowsIdeas', vaultName: 'ideas', absolutePath: 'C:\\Users\\joaop\\obsidian\\ideas\\Note.md', relativePath: 'Note.md', basename: 'Note', extension: '.md', mtime: 1, size: 1 }] });
  const cacheApp = { vault: { configDir: '.obsidian', adapter: { exists: async () => true, read: async () => cache, write: async (_p: string, value: string) => { cache = value; }, mkdir: async () => undefined } } } as never;
  const migrated = await new IndexStore(cacheApp).loadIndex(registry);
  expect(migrated.files[0]).toMatchObject({ vaultId: 'windowsIdeas', absolutePath: path.join(ideas, 'Note.md') });
  const first = JSON.stringify(registry.getPersistedVaults());
  expect(first).not.toContain('C:');
  const second = new VaultRegistry(app, { vaults: JSON.parse(first) } as never, { platform: 'linux', env: {}, home: root, localPaths, discoveredVaults: discovered, generateId: () => 'generated' });
  expect(JSON.stringify(second.getPersistedVaults())).toBe(first);
});
