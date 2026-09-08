import { describe, expect, it } from 'vitest';
import { backupPortableMigrationFiles } from '../src/portable-migration-backup';

function adapter(initial: Record<string, string>) {
  const files = new Map(Object.entries(initial));
  return {
    files,
    api: {
      exists: async (path: string) => files.has(path),
      read: async (path: string) => files.get(path)!,
      write: async (path: string, value: string) => { files.set(path, value); },
    },
  };
}

describe('portable migration backups', () => {
  it('copies settings and cache before migration', async () => {
    const root = '.obsidian/plugins/multi-vault-navigator';
    const fixture = adapter({ [`${root}/data.json`]: 'original settings', [`${root}/index-cache.json`]: 'original cache' });
    await backupPortableMigrationFiles(fixture.api, root);
    expect(fixture.files.get(`${root}/data.pre-portable-paths.json`)).toBe('original settings');
    expect(fixture.files.get(`${root}/index-cache.pre-portable-paths.json`)).toBe('original cache');
  });

  it('never overwrites an existing backup and tolerates a missing cache', async () => {
    const root = '.obsidian/plugins/multi-vault-navigator';
    const fixture = adapter({ [`${root}/data.json`]: 'new settings', [`${root}/data.pre-portable-paths.json`]: 'first settings' });
    await backupPortableMigrationFiles(fixture.api, root);
    expect(fixture.files.get(`${root}/data.pre-portable-paths.json`)).toBe('first settings');
    expect(fixture.files.has(`${root}/index-cache.pre-portable-paths.json`)).toBe(false);
  });
});
