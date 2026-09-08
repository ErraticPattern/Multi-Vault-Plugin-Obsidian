import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { VaultRegistry } from '../src/vault-registry';
import type { LocalVaultPathStore } from '../src/local-vault-path-store';

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));
function vault(name: string) { const root = mkdtempSync(path.join(tmpdir(), 'mvn-reg-')); roots.push(root); const value = path.join(root, name); mkdirSync(path.join(value, '.obsidian'), { recursive: true }); return value; }
function store(values: Record<string, string> = {}) {
  return { load: () => ({ version: 1 as const, vaultPaths: { ...values } }), get: (id: string) => values[id], set: (id: string, value: string) => { values[id] = value; }, remove: (id: string) => { delete values[id]; } } as LocalVaultPathStore;
}
const app = (current: string) => ({ vault: { configDir: '.obsidian', adapter: { getBasePath: () => current } } }) as never;

describe('vault registry portability', () => {
  it('collapses polluted entries and resolves from the local registry', () => {
    const local = vault('ideas');
    const settings = { vaults: [
      { id: 'windows-id', name: 'ideas', path: 'C:\\Users\\joaop\\obsidian\\ideas', enabled: true, color: '#123456' },
      { id: 'linux-id', name: 'ideas', path: local, enabled: false },
    ] } as never;
    const registry = new VaultRegistry(app(local), settings, {
      platform: 'linux', home: '/home/a', env: {}, localPaths: store(),
      discoveredVaults: [{ registryId: 'registry-id', name: 'ideas', path: local, registryPath: '/config/obsidian.json' }],
      generateId: () => 'generated',
    });
    expect(registry.getVaults()).toEqual([expect.objectContaining({ id: 'windows-id', path: local, available: true, enabled: true, color: '#123456' })]);
    expect(registry.getIdAliases().get('linux-id')).toBe('windows-id');
    expect(registry.getPersistedVaults()[0]).not.toHaveProperty('path');
  });

  it('keeps remote vaults unavailable and relinks without changing identity', () => {
    const current = vault('current');
    const target = vault('medicine');
    const registry = new VaultRegistry(app(current), { vaults: [{ id: 'medicine-id', name: 'medicine', enabled: true }] } as never, {
      platform: 'linux', home: '/home/a', env: {}, localPaths: store(), discoveredVaults: [], generateId: () => 'current-id',
    });
    expect(registry.getVaultById('medicine-id')).toMatchObject({ available: false, path: '' });
    expect(registry.relinkVault('medicine-id', target)).toBe(true);
    expect(registry.getVaultById('medicine-id')).toMatchObject({ available: true, path: target });
  });
});
