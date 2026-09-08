import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { chooseLocalConfigDirectory, discoverObsidianVaults } from '../src/obsidian-vault-discovery';

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'mvn-discovery-'));
  roots.push(root);
  const vault = path.join(root, 'ideas');
  mkdirSync(path.join(vault, '.obsidian'), { recursive: true });
  return { root, vault };
}

describe('Obsidian vault discovery', () => {
  it('continues after malformed registries and expands mixed paths', () => {
    const { root, vault } = fixture();
    const broken = path.join(root, 'broken', 'obsidian.json');
    const valid = path.join(root, 'flatpak', 'obsidian.json');
    mkdirSync(path.dirname(broken), { recursive: true });
    mkdirSync(path.dirname(valid), { recursive: true });
    writeFileSync(broken, '{');
    writeFileSync(valid, JSON.stringify({ vaults: { id1: { path: vault.replace(/\//g, '\\') } } }));
    const errors: string[] = [];
    const found = discoverObsidianVaults([broken, valid], {
      platform: 'linux', env: {}, home: root, configDirName: '.obsidian',
      logError: message => errors.push(message),
    });
    expect(found).toEqual([{ registryId: 'id1', name: 'ideas', path: vault, registryPath: valid }]);
    expect(errors).toHaveLength(1);
  });

  it('deduplicates paths and chooses the registry containing the current vault', () => {
    const { root, vault } = fixture();
    const first = path.join(root, 'first', 'obsidian.json');
    const active = path.join(root, 'active', 'obsidian.json');
    for (const file of [first, active]) mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(first, JSON.stringify({ vaults: { old: { path: vault } } }));
    writeFileSync(active, JSON.stringify({ vaults: { current: { path: vault } } }));
    const found = discoverObsidianVaults([first, active], {
      platform: 'linux', env: {}, home: root, configDirName: '.obsidian', logError: () => undefined,
    });
    expect(found).toHaveLength(1);
    expect(chooseLocalConfigDirectory([first, active], vault, found, 'linux', {}, root))
      .toBe(path.dirname(first));
  });

  it('falls back to the normal platform config directory', () => {
    expect(chooseLocalConfigDirectory([], null, [], 'linux', {}, '/home/a'))
      .toBe('/home/a/.config/obsidian');
  });
});
