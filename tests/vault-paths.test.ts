import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { expandPortablePath, getObsidianConfigCandidates, rebaseRelativePath } from '../src/vault-paths';

describe('portable vault paths', () => {
  it('finds standard and sandboxed Linux registries', () => {
    expect(getObsidianConfigCandidates('linux', {}, '/home/a')).toEqual([
      '/home/a/.config/obsidian/obsidian.json',
      '/home/a/.var/app/md.obsidian.Obsidian/config/obsidian/obsidian.json',
      '/home/a/snap/obsidian/current/.config/obsidian/obsidian.json',
    ]);
    expect(getObsidianConfigCandidates('linux', { XDG_CONFIG_HOME: '/cfg' }, '/home/a')[0])
      .toBe('/cfg/obsidian/obsidian.json');
  });

  it('finds native Windows and macOS registries', () => {
    expect(getObsidianConfigCandidates('win32', { APPDATA: 'C:\\Users\\a\\AppData\\Roaming' }, 'C:\\Users\\a'))
      .toEqual(['C:\\Users\\a\\AppData\\Roaming\\Obsidian\\obsidian.json']);
    expect(getObsidianConfigCandidates('darwin', {}, '/Users/a'))
      .toEqual(['/Users/a/Library/Application Support/obsidian/obsidian.json']);
  });

  it.each(['~/obsidian', '$HOME/obsidian', '${HOME}/obsidian'])(
    'expands home form %s', (value) => {
      expect(expandPortablePath(value, {}, '/home/a')).toBe(path.normalize('/home/a/obsidian'));
    },
  );

  it('expands USERPROFILE and rebases only safe relative paths', () => {
    expect(expandPortablePath('%USERPROFILE%\\obsidian', { USERPROFILE: 'C:\\Users\\a' }, '/home/a'))
      .toBe(path.normalize('C:/Users/a/obsidian'));
    expect(rebaseRelativePath('/vault', 'Notes\\note.md')).toBe(path.join('/vault', 'Notes', 'note.md'));
    for (const unsafe of ['/absolute.md', 'C:\\absolute.md', '../escape.md', 'Notes/../../escape.md']) {
      expect(rebaseRelativePath('/vault', unsafe)).toBeNull();
    }
  });
});
