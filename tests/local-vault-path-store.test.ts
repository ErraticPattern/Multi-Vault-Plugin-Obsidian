import { describe, expect, it } from 'vitest';
import { LocalVaultPathStore, LocalPathFileSystem } from '../src/local-vault-path-store';

function fakeFs(initial?: string, failRename = false) {
  const files = new Map<string, string>();
  if (initial !== undefined) files.set('/config/local.json', initial);
  const fs: LocalPathFileSystem = {
    existsSync: p => files.has(p),
    readFileSync: p => files.get(p)!,
    mkdirSync: () => undefined,
    writeFileSync: (p, data) => { files.set(p, data); },
    renameSync: (from, to) => {
      if (failRename) throw new Error('rename failed');
      files.set(to, files.get(from)!); files.delete(from);
    },
    unlinkSync: p => { files.delete(p); },
  };
  return { files, fs };
}

describe('local vault path store', () => {
  it('loads missing, malformed, and valid files safely', () => {
    expect(new LocalVaultPathStore('/config/local.json', fakeFs().fs).load().vaultPaths).toEqual({});
    expect(new LocalVaultPathStore('/config/local.json', fakeFs('{').fs).load().vaultPaths).toEqual({});
    const valid = fakeFs(JSON.stringify({ version: 1, vaultPaths: { ideas: '/vault' } }));
    expect(new LocalVaultPathStore('/config/local.json', valid.fs).load().vaultPaths).toEqual({ ideas: '/vault' });
  });

  it('writes updates atomically', () => {
    const fixture = fakeFs();
    const store = new LocalVaultPathStore('/config/local.json', fixture.fs);
    store.set('ideas', '/vault');
    expect(JSON.parse(fixture.files.get('/config/local.json')!)).toEqual({ version: 1, vaultPaths: { ideas: '/vault' } });
    expect(fixture.files.has('/config/local.json.tmp')).toBe(false);
    store.remove('ideas');
    expect(store.get('ideas')).toBeUndefined();
  });

  it('preserves disk and memory when replacement fails', () => {
    const original = JSON.stringify({ version: 1, vaultPaths: { ideas: '/old' } });
    const fixture = fakeFs(original, true);
    const store = new LocalVaultPathStore('/config/local.json', fixture.fs);
    store.load();
    expect(() => store.set('ideas', '/new')).toThrow('rename failed');
    expect(store.get('ideas')).toBe('/old');
    expect(fixture.files.get('/config/local.json')).toBe(original);
    expect(fixture.files.has('/config/local.json.tmp')).toBe(false);
  });
});
