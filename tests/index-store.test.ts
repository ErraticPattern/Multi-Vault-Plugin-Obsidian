import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { IndexStore } from '../src/indexer/index-store';

function setup(files: object[]) {
  let content = JSON.stringify({ version: 2, generatedAt: '', files });
  let writes = 0;
  const app = { vault: { configDir: '.obsidian', adapter: {
    exists: async () => true, read: async () => content,
    write: async (_p: string, value: string) => { content = value; writes++; }, mkdir: async () => undefined,
  } } } as never;
  return { store: new IndexStore(app), get writes() { return writes; } };
}
const file = (vaultId: string, relativePath: string, absolutePath = `C:\\vault\\${relativePath}`) => ({
  id: `${vaultId}:${relativePath}`, vaultId, vaultName: 'ideas', absolutePath, relativePath,
  basename: 'note', extension: '.md', mtime: 1, size: 1,
});

describe('portable index cache', () => {
  it('canonicalizes IDs and rebases safe relative paths', async () => {
    const fixture = setup([file('old-id', 'Notes\\note.md')]);
    const registry = { getIdAliases: () => new Map([['old-id', 'ideas-id']]), getVaultById: () => ({ id: 'ideas-id', available: true, path: '/vaults/ideas' }) } as never;
    const result = await fixture.store.loadIndex(registry);
    expect(result.migrated).toBe(true);
    expect(result.files[0]).toMatchObject({ vaultId: 'ideas-id', relativePath: 'Notes/note.md', absolutePath: path.join('/vaults/ideas', 'Notes', 'note.md') });
  });

  it('retains unavailable entries and drops unsafe relative paths', async () => {
    const fixture = setup([file('remote', 'Note.md'), file('ideas', '../escape.md')]);
    const registry = { getIdAliases: () => new Map(), getVaultById: (id: string) => id === 'remote' ? { available: false, path: null } : { available: true, path: '/vault' } } as never;
    const result = await fixture.store.loadIndex(registry);
    expect(result.files).toEqual([expect.objectContaining({ vaultId: 'remote', absolutePath: 'C:\\vault\\Note.md' })]);
    expect(result.migrated).toBe(true);
  });
});
