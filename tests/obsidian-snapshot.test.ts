import { describe, expect, it } from 'vitest';
import { TFile } from 'obsidian';
import { collectMigrationSnapshot } from '../src/migration/obsidian-snapshot';

function testFile(filePath: string): TFile {
  const file = new TFile();
  const name = filePath.split('/').pop() ?? filePath;
  Object.assign(file, {
    path: filePath,
    name,
    basename: name.replace(/\.md$/i, ''),
    extension: name.split('.').pop() ?? '',
  });
  return file;
}

function link(original: string, target: string, content: string) {
  const start = content.indexOf(original);
  return {
    original,
    link: target,
    position: { start: { offset: start }, end: { offset: start + original.length } },
  };
}

describe('collectMigrationSnapshot', () => {
  it('reads only the exact source and notes whose resolved links target it', async () => {
    const rootReadme = testFile('README.md');
    const labReadme = testFile('Lab/README.md');
    const index = testFile('Index.md');
    const unrelated = testFile('Unrelated.md');
    const files = [rootReadme, labReadme, index, unrelated];
    const contents = new Map([
      [rootReadme.path, 'Root.'],
      [labReadme.path, 'Lab.'],
      [index.path, 'See [[Lab/README]].'],
      [unrelated.path, 'See [[README]].'],
    ]);
    const caches = new Map([
      [index.path, { links: [link('[[Lab/README]]', 'Lab/README', contents.get(index.path)!)] }],
      [unrelated.path, { links: [link('[[README]]', 'README', contents.get(unrelated.path)!)] }],
    ]);
    const reads: string[] = [];
    const app = {
      vault: {
        getFileByPath: (filePath: string) => files.find((file) => file.path === filePath) ?? null,
        read: async (file: TFile) => {
          reads.push(file.path);
          return contents.get(file.path)!;
        },
      },
      metadataCache: {
        resolvedLinks: {
          'Index.md': { 'Lab/README.md': 1 },
          'Unrelated.md': { 'README.md': 1 },
        },
        getFileCache: (file: TFile) => caches.get(file.path) ?? {},
        getFirstLinkpathDest: (target: string) => target === 'Lab/README' ? labReadme : rootReadme,
      },
    };

    const notes = await collectMigrationSnapshot(app as never, 'Lab/README.md');

    expect(notes.map((note) => note.path)).toEqual(['Index.md', 'Lab/README.md']);
    expect(reads).toEqual(['Index.md', 'Lab/README.md']);
    expect(notes[0].links[0].resolvedPath).toBe('Lab/README.md');
  });

  it('does not read 10,000 unrelated notes', async () => {
    const source = testFile('Source.md');
    const backlink = testFile('Backlink.md');
    const files = [source, backlink];
    const resolvedLinks: Record<string, Record<string, number>> = {
      'Backlink.md': { 'Source.md': 1 },
    };
    for (let index = 0; index < 10_000; index += 1) {
      resolvedLinks[`Unrelated-${index}.md`] = { 'Other.md': 1 };
    }
    const reads: string[] = [];
    const app = {
      vault: {
        getFileByPath: (filePath: string) => files.find((file) => file.path === filePath) ?? null,
        read: async (file: TFile) => { reads.push(file.path); return file.path; },
      },
      metadataCache: {
        resolvedLinks,
        getFileCache: () => ({}),
        getFirstLinkpathDest: () => null,
      },
    };

    await collectMigrationSnapshot(app as never, source.path);

    expect(reads).toEqual(['Backlink.md', 'Source.md']);
  });

  it('reads only the source when it has no backlinks', async () => {
    const source = testFile('Source.md');
    const reads: string[] = [];
    const app = {
      vault: {
        getFileByPath: (filePath: string) => filePath === source.path ? source : null,
        read: async (file: TFile) => { reads.push(file.path); return 'Source.'; },
      },
      metadataCache: {
        resolvedLinks: {},
        getFileCache: () => ({}),
        getFirstLinkpathDest: () => null,
      },
    };

    const notes = await collectMigrationSnapshot(app as never, source.path);

    expect(notes.map((note) => note.path)).toEqual(['Source.md']);
    expect(reads).toEqual(['Source.md']);
  });
});
