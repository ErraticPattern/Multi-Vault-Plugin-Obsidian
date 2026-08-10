import { describe, expect, it } from 'vitest';
import { TFile } from 'obsidian';
import {
  MOVE_COPY_COMMAND_ID,
  RELINK_BACKLINKS_COMMAND_ID,
  registerMigrationCommands,
} from '../src/migration/migration-commands';
import {
  MigrationController,
  resolveRelinkTargetRelativePath,
} from '../src/migration/migration-controller';
import type { MigrationIo } from '../src/migration/migration-transaction';
import {
  getFolderSuggestions,
  getTargetNoteSuggestions,
  makeMigrationReviewModel,
  makeRelinkPreviewModel,
} from '../src/migration/migration-view-models';
import type { IndexedFile, VaultConfig } from '../src/types';
import { formatCrossVaultWikilink } from '../src/migration/cross-vault-link';

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

class ControllerIo implements MigrationIo {
  source = new Map<string, string>();
  destination = new Map<string, string>();
  async destinationExists(path: string) { return this.destination.has(path); }
  async readDestination(path: string) { return this.destination.get(path) ?? ''; }
  async writeDestination(path: string, content: string) { this.destination.set(path, content); }
  async removeDestination(path: string) { this.destination.delete(path); }
  async readSourceFile(path: string) { return this.source.get(path)!; }
  async writeSourceFile(path: string, content: string) { this.source.set(path, content); }
  async trashSourceFile(path: string) { this.source.delete(path); }
  async restoreSourceFile(path: string, content: string) { this.source.set(path, content); }
}

describe('cross-vault clipboard links', () => {
  it('formats the selected vault and current note as a natural cross-vault wikilink', () => {
    expect(formatCrossVaultWikilink('medicine', 'ZeroTier')).toBe('[[medicine::ZeroTier]]');
  });
});

describe('migration command registration', () => {
  it('registers move/copy and standalone relink commands with their modal factories', () => {
    const commands: Array<{ id: string; callback: () => void }> = [];
    const opened: string[] = [];
    const host = { addCommand: (command: { id: string; callback: () => void }) => commands.push(command) };

    registerMigrationCommands(host, {
      openMoveCopy: () => opened.push('move-copy'),
      openRelink: () => opened.push('relink'),
    });

    expect(commands.map(({ id }) => id)).toEqual([
      MOVE_COPY_COMMAND_ID,
      RELINK_BACKLINKS_COMMAND_ID,
    ]);
    commands.forEach(({ callback }) => callback());
    expect(opened).toEqual(['move-copy', 'relink']);
  });
});

describe('migration picker and review view models', () => {
  it('returns safe folder and target-note suggestions', () => {
    expect(getFolderSuggestions(['Notes/Networks', '/', 'Notes'])).toEqual([
      '/', 'Notes', 'Notes/Networks',
    ]);
    const files = [
      { vaultId: 'math', extension: '.md', relativePath: 'Notes/Zerotier.md', basename: 'Zerotier' },
      { vaultId: 'math', extension: 'png', relativePath: 'image.png', basename: 'image' },
      { vaultId: 'ideas', extension: 'md', relativePath: 'Other.md', basename: 'Other' },
    ] as IndexedFile[];
    expect(getTargetNoteSuggestions(files, 'math').map(({ relativePath }) => relativePath))
      .toEqual(['Notes/Zerotier.md']);
  });

  it('allows an optional relink target when the note name is unambiguous', () => {
    const targetFiles = [
      { vaultId: 'medicine', extension: '.md', relativePath: 'Notes/ZeroTier.md', basename: 'ZeroTier' },
    ] as IndexedFile[];
    expect(resolveRelinkTargetRelativePath('ZeroTier', targetFiles)).toBe('Notes/ZeroTier.md');
    expect(resolveRelinkTargetRelativePath('Missing', targetFiles)).toBe('Missing.md');
    expect(resolveRelinkTargetRelativePath('ZeroTier', targetFiles, targetFiles[0]))
      .toBe('Notes/ZeroTier.md');
  });

  it('requires explicit selection only when duplicate target names are ambiguous', () => {
    const targetFiles = [
      { vaultId: 'medicine', extension: '.md', relativePath: 'Notes/ZeroTier.md', basename: 'ZeroTier' },
      { vaultId: 'medicine', extension: '.md', relativePath: 'Archive/ZeroTier.md', basename: 'ZeroTier' },
    ] as IndexedFile[];
    expect(() => resolveRelinkTargetRelativePath('ZeroTier', targetFiles)).toThrow(/multiple/i);
  });

  it('summarizes destination, rewrites, affected files, and skipped reasons', () => {
    const model = makeMigrationReviewModel({
      mode: 'move', sourcePath: 'Source.md', sourceOriginalContent: 'source',
      destinationAbsolutePath: 'C:/math/Notes/Source.md',
      destinationRelativePath: 'Notes/Source.md', destinationContent: 'source',
      backlinkEdits: [
        { path: 'A.md', originalContent: 'a', updatedContent: 'A', rewrittenLinks: 2 },
        { path: 'B.md', originalContent: 'b', updatedContent: 'B', rewrittenLinks: 1 },
      ],
      outgoingLinksRewritten: 4, backlinksRewritten: 3,
      skipped: [
        { sourcePath: 'Source.md', original: '![[x]]', reason: 'embed' },
        { sourcePath: 'Source.md', original: '[[x]]', reason: 'unresolved' },
        { sourcePath: 'Source.md', original: '[[y]]', reason: 'unresolved' },
      ],
    });

    expect(model).toMatchObject({
      destination: 'Notes/Source.md',
      outgoingLinks: 4,
      backlinks: 3,
      affectedFiles: 2,
      skippedByReason: { embed: 1, unresolved: 2 },
    });
  });

  it('previews backlink counts and exact source-to-destination link conversions', () => {
    const plan = {
      mode: 'relink', sourcePath: 'ZeroTier.md', sourceOriginalContent: 'source',
      destinationAbsolutePath: null, destinationRelativePath: null, destinationContent: null,
      backlinkEdits: [{
        path: 'Index.md', originalContent: 'See [[ZeroTier]].',
        updatedContent: 'See [[medicine::ZeroTier]].', rewrittenLinks: 1,
        rewrites: [{ before: '[[ZeroTier]]', after: '[[medicine::ZeroTier]]' }],
      }],
      outgoingLinksRewritten: 0, backlinksRewritten: 1, skipped: [],
    } as never;

    expect(makeRelinkPreviewModel(plan)).toEqual({
      backlinks: 1,
      affectedFiles: 1,
      examples: [{
        sourcePath: 'Index.md',
        before: '[[ZeroTier]]',
        after: '[[medicine::ZeroTier]]',
      }],
    });
  });
});

describe('MigrationController', () => {
  it('plans a nested-folder move and refreshes the index only after execution', async () => {
    const source = testFile('Projects/Zerotier.md');
    const eeg = testFile('Notes/EEG.md');
    const index = testFile('Notes/Index.md');
    const contents = new Map([
      [source.path, 'Uses [[EEG]].'],
      [eeg.path, 'EEG.'],
      [index.path, 'See [[Zerotier]].'],
    ]);
    const caches = new Map([
      [source.path, { links: [{
        original: '[[EEG]]', link: 'EEG',
        position: { start: { offset: 5 }, end: { offset: 12 } },
      }] }],
      [index.path, { links: [{
        original: '[[Zerotier]]', link: 'Zerotier',
        position: { start: { offset: 4 }, end: { offset: 16 } },
      }] }],
    ]);
    const files = [source, eeg, index];
    const app = {
      vault: {
        getMarkdownFiles: () => files,
        read: async (file: TFile) => contents.get(file.path)!,
      },
      metadataCache: {
        getFileCache: (file: TFile) => caches.get(file.path) ?? {},
        getFirstLinkpathDest: (link: string) => link === 'EEG' ? eeg : source,
      },
    };
    const vaults: VaultConfig[] = [
      { id: 'ideas', name: 'ideas', path: 'C:/vaults/ideas', enabled: true },
      { id: 'math', name: 'mathematics', path: 'C:/vaults/mathematics', enabled: true },
    ];
    let refreshes = 0;
    const indexer = {
      getIndexedFiles: () => files.map((file) => ({
        id: file.path, vaultId: 'ideas', vaultName: 'ideas',
        absolutePath: `C:/vaults/ideas/${file.path}`, relativePath: file.path,
        basename: file.basename, extension: '.md', mtime: 0, size: 0,
      })),
      buildFullIndex: async () => { refreshes += 1; },
    };
    const registry = {
      getCurrentVaultId: () => 'ideas',
      getVaultById: (id: string) => vaults.find((vault) => vault.id === id),
    };
    const io = new ControllerIo();
    io.source = new Map(contents);
    const controller = new MigrationController(
      app as never,
      registry as never,
      indexer as never,
      () => io,
    );

    const plan = await controller.planMoveCopy(source, 'math', 'Notes', 'move', true);

    expect(plan.destinationRelativePath).toBe('Notes/Zerotier.md');
    expect(plan.destinationContent).toBe('Uses [[ideas::EEG]].');
    expect(plan.backlinkEdits[0].updatedContent).toBe('See [[mathematics::Zerotier]].');
    expect(refreshes).toBe(0);

    await controller.execute(plan);
    expect(refreshes).toBe(1);
  });
});
