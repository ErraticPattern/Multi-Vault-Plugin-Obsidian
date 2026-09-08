import { beforeEach, describe, expect, it } from 'vitest';
import { TFile } from 'obsidian';
import { __resetObsidianMock } from './mocks/obsidian';
import {
  MOVE_COPY_COMMAND_ID,
  RELINK_BACKLINKS_COMMAND_ID,
  registerMigrationCommands,
} from '../src/migration/migration-commands';
import {
  MigrationController,
  resolveRelinkTargetRelativePath,
} from '../src/migration/migration-controller';
import type { DestinationOwnershipToken, MigrationIo } from '../src/migration/migration-transaction';
import { DestinationExistsError } from '../src/migration/migration-transaction';
import { resolveDestinationPath } from '../src/migration/destination-paths';
import {
  getFolderSuggestions,
  getTargetNoteSuggestions,
  makeMigrationReviewModel,
  makeRelinkPreviewModel,
} from '../src/migration/migration-view-models';
import type { IndexedFile, VaultConfig } from '../src/types';
import { formatCrossVaultWikilink } from '../src/migration/cross-vault-link';
import {
  FileOperationModal,
  formatMigrationPlanningError,
} from '../src/modals/file-operation-modal';
import { handleMigrationReviewConfirmation } from '../src/modals/migration-review-modal';

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
  async writeDestination(path: string, content: string, originalContent: string | null) {
    this.destination.set(path, content);
    return { path, originalContent } as unknown as DestinationOwnershipToken;
  }
  async restoreDestination(path: string, ownership: DestinationOwnershipToken) {
    const token = ownership as unknown as { originalContent: string | null };
    if (token.originalContent === null) this.destination.delete(path);
    else this.destination.set(path, token.originalContent);
  }
  async readSourceFile(path: string) { return this.source.get(path)!; }
  async writeSourceFile(path: string, content: string) { this.source.set(path, content); }
  async trashSourceFile(path: string) { this.source.delete(path); }
  async restoreSourceFile(path: string, content: string) { this.source.set(path, content); }
}

type MockButton = {
  buttonText: string;
  disabled: boolean;
  triggerClick(): Promise<unknown>;
};

type MockToggle = {
  triggerChange(value: boolean): Promise<unknown>;
};

function findButton(modal: { contentEl: unknown }, label: string): MockButton {
  const settings = (modal.contentEl as { settings: Array<{ buttons: MockButton[] }> }).settings;
  const button = settings.flatMap((setting) => setting.buttons)
    .find((candidate) => candidate.buttonText === label);
  if (!button) throw new Error(`Missing button: ${label}`);
  return button;
}

function findToggle(modal: { contentEl: unknown }, name: string): MockToggle {
  const settings = (modal.contentEl as { settings: Array<{ name: string; toggles: MockToggle[] }> }).settings;
  const toggle = settings.find((setting) => setting.name === name)?.toggles[0];
  if (!toggle) throw new Error(`Missing toggle: ${name}`);
  return toggle;
}

beforeEach(() => {
  __resetObsidianMock();
});

describe('cross-vault clipboard links', () => {
  it('formats the selected vault and current note as a natural cross-vault wikilink', () => {
    expect(formatCrossVaultWikilink('medicine', 'ZeroTier')).toBe('[[ZeroTier@medicine]]');
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

describe('migration planning error formatting', () => {
  it('keeps explicit destination-exists guidance while preserving generic fallback messaging', () => {
    expect(formatMigrationPlanningError(new DestinationExistsError('C:/vaults/mathematics/Notes/Zerotier.md')))
      .toBe('Destination already exists. Use “Relink Backlinks to Existing Cross-Vault Note” when this note already exists there.');
    expect(formatMigrationPlanningError(new Error('planner unavailable')))
      .toBe('Could not prepare migration: planner unavailable');
  });
});

describe('FileOperationModal overwrite toggle', () => {
  it('passes overwriteDestination as false by default and true after the toggle changes', async () => {
    const activeFile = testFile('Projects/Zerotier.md');
    const vaults: VaultConfig[] = [
      { id: 'ideas', name: 'ideas', path: 'C:/vaults/ideas', enabled: true },
      { id: 'math', name: 'mathematics', path: 'C:/vaults/mathematics', enabled: true },
    ];
    const planCalls: unknown[][] = [];
    const plan = {
      mode: 'copy',
      sourcePath: activeFile.path,
      sourceOriginalContent: 'source',
      destinationAbsolutePath: 'C:/vaults/mathematics/Projects/Zerotier.md',
      destinationRelativePath: 'Projects/Zerotier.md',
      destinationContent: 'source',
      destinationPolicy: 'create-only',
      destinationOriginalContent: null,
      backlinkEdits: [],
      outgoingLinksRewritten: 0,
      backlinksRewritten: 0,
      skipped: [],
    } as never;
    const controller = {
      planMoveCopy: async (...args: unknown[]) => {
        planCalls.push(args);
        return plan;
      },
      execute: async () => ({
        mode: 'copy' as const,
        outgoingLinksRewritten: 0,
        backlinksRewritten: 0,
        indexUpdated: true,
      }),
    };
    const registry = {
      getCurrentVaultId: () => 'ideas',
      getVaults: () => vaults,
      getVaultById: (id: string) => vaults.find((vault) => vault.id === id),
    };
    const indexer = { getIndexedFiles: () => [] };
    const app = {
      workspace: { getActiveFile: () => activeFile },
      metadataCache: { getFileCache: () => ({}) },
    };
    const modal = new FileOperationModal(app as never, registry as never, indexer as never, controller as never);

    modal.onOpen();
    await findButton(modal, 'Review changes').triggerClick();
    await findToggle(modal, 'Overwrite existing destination').triggerChange(true);
    await findButton(modal, 'Review changes').triggerClick();

    modal.onOpen();
    await findButton(modal, 'Review changes').triggerClick();

    expect(planCalls.map((args) => args[5])).toEqual([false, true, false]);
  });
});

describe('migration review confirmation routing', () => {
  it('opens a second confirmation only for reviewed overwrites', async () => {
    const calls: string[] = [];
    let deferredConfirm: (() => Promise<void>) | null = null;
    let closeOverwriteConfirm: (() => void) | null = null;
    let reviewConfirmDisabled = false;

    await handleMigrationReviewConfirmation(
      {
        destinationAbsolutePath: 'C:/vaults/mathematics/Notes/Zerotier.md',
        destinationPolicy: 'overwrite-reviewed',
      } as never,
      async () => {
        calls.push('execute');
      },
      (destinationPath, onConfirm, onClose) => {
        calls.push(`prompt:${destinationPath}`);
        deferredConfirm = onConfirm;
        closeOverwriteConfirm = onClose;
      },
      (disabled) => {
        reviewConfirmDisabled = disabled;
      },
    );

    expect(calls).toEqual(['prompt:C:/vaults/mathematics/Notes/Zerotier.md']);
    expect(deferredConfirm).not.toBeNull();
    expect(reviewConfirmDisabled).toBe(true);

    if (!closeOverwriteConfirm) {
      throw new Error('Expected overwrite close callback');
    }
    const cancelOverwrite = closeOverwriteConfirm as () => void;
    cancelOverwrite();
    expect(reviewConfirmDisabled).toBe(false);

    if (!deferredConfirm) {
      throw new Error('Expected overwrite confirmation callback');
    }
    const confirmOverwrite = deferredConfirm as () => Promise<void>;
    await confirmOverwrite();
    expect(calls).toEqual([
      'prompt:C:/vaults/mathematics/Notes/Zerotier.md',
      'execute',
    ]);

    calls.length = 0;
    deferredConfirm = null;

    await handleMigrationReviewConfirmation(
      {
        destinationAbsolutePath: 'C:/vaults/mathematics/Notes/Zerotier.md',
        destinationPolicy: 'create-only',
      } as never,
      async () => {
        calls.push('execute');
      },
      () => {
        calls.push('prompt');
      },
      (disabled) => {
        reviewConfirmDisabled = disabled;
      },
    );

    expect(calls).toEqual(['execute']);
    expect(deferredConfirm).toBeNull();
  });
});

describe('MigrationController', () => {
  it('rejects collisions unless overwrite is enabled and captures reviewed destination state', async () => {
    const source = testFile('Projects/Zerotier.md');
    const app = {
      vault: {
        getMarkdownFiles: () => [source],
        getFileByPath: (filePath: string) => filePath === source.path ? source : null,
        read: async (file: TFile) => file.path === source.path ? 'Uses [[EEG]].' : '',
      },
      metadataCache: {
        resolvedLinks: {},
        getFileCache: () => ({ links: [] }),
        getFirstLinkpathDest: () => null,
      },
    };
    const vaults: VaultConfig[] = [
      { id: 'ideas', name: 'ideas', path: 'C:/vaults/ideas', enabled: true },
      { id: 'math', name: 'mathematics', path: 'C:/vaults/mathematics', enabled: true },
    ];
    const indexer = {
      getIndexedFiles: () => [source].map((file) => ({
        id: file.path, vaultId: 'ideas', vaultName: 'ideas',
        absolutePath: `C:/vaults/ideas/${file.path}`, relativePath: file.path,
        basename: file.basename, extension: '.md', mtime: 0, size: 0,
      })),
      buildFullIndex: async () => {},
      applyMutations: async () => {},
    };
    const registry = {
      getCurrentVaultId: () => 'ideas',
      getVaults: () => vaults,
      getVaultById: (id: string) => vaults.find((vault) => vault.id === id),
    };
    const io = new ControllerIo();
    io.source.set(source.path, 'Uses [[EEG]].');
    const destination = resolveDestinationPath('C:/vaults/mathematics', 'Notes', source.name);
    io.destination.set(destination.absolutePath, 'existing target');
    const controller = new MigrationController(
      app as never,
      registry as never,
      indexer as never,
      () => io,
    );

    await expect(controller.planMoveCopy(source, 'math', 'Notes', 'move', true, false))
      .rejects.toBeInstanceOf(DestinationExistsError);

    const overwritten = await controller.planMoveCopy(source, 'math', 'Notes', 'copy', true, true);
    expect(overwritten).toMatchObject({
      destinationPolicy: 'overwrite-reviewed',
      destinationOriginalContent: 'existing target',
    });

    io.destination.delete(destination.absolutePath);
    const clean = await controller.planMoveCopy(source, 'math', 'Notes', 'copy', true, true);
    expect(clean).toMatchObject({
      destinationPolicy: 'create-only',
      destinationOriginalContent: null,
    });
  });

  it('plans a nested-folder move and incrementally updates only changed index entries', async () => {
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
        getFileByPath: (filePath: string) => files.find((file) => file.path === filePath) ?? null,
        read: async (file: TFile) => contents.get(file.path)!,
      },
      metadataCache: {
        resolvedLinks: {
          [source.path]: { [eeg.path]: 1 },
          [index.path]: { [source.path]: 1 },
        },
        getFileCache: (file: TFile) => caches.get(file.path) ?? {},
        getFirstLinkpathDest: (link: string) => link === 'EEG' ? eeg : source,
      },
    };
    const vaults: VaultConfig[] = [
      { id: 'ideas', name: 'ideas', path: 'C:/vaults/ideas', enabled: true, available: true },
      { id: 'math', name: 'mathematics', path: 'C:/vaults/mathematics', enabled: true, available: true },
    ];
    let refreshes = 0;
    const appliedMutations: unknown[] = [];
    const indexer = {
      getIndexedFiles: () => files.map((file) => ({
        id: file.path, vaultId: 'ideas', vaultName: 'ideas',
        absolutePath: `C:/vaults/ideas/${file.path}`, relativePath: file.path,
        basename: file.basename, extension: '.md', mtime: 0, size: 0,
      })),
      buildFullIndex: async () => { refreshes += 1; },
      applyMutations: async (mutations: unknown[]) => { appliedMutations.push(...mutations); },
    };
    const registry = {
      getCurrentVaultId: () => 'ideas',
      getVaults: () => vaults,
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
    expect(plan.destinationContent).toBe('Uses [[EEG@ideas]].');
    expect(plan.backlinkEdits[0].updatedContent).toBe('See [[Zerotier@mathematics]].');
    expect(refreshes).toBe(0);

    const result = await controller.execute(plan);
    expect(result.indexUpdated).toBe(true);
    expect(refreshes).toBe(0);
    expect(appliedMutations).toEqual([
      { kind: 'remove', vaultId: 'ideas', relativePath: 'Projects/Zerotier.md' },
      { kind: 'upsert', vaultId: 'math', relativePath: 'Notes/Zerotier.md' },
      { kind: 'upsert', vaultId: 'ideas', relativePath: 'Notes/Index.md' },
    ]);
  });

  it('reports a post-commit index failure without reporting migration rollback', async () => {
    const io = new ControllerIo();
    io.source.set('Source.md', 'Source.');
    const controller = new MigrationController(
      { metadataCache: { resolvedLinks: {} } } as never,
      {} as never,
      { applyMutations: async () => { throw new Error('cache unavailable'); } } as never,
      () => io,
    );
    const migrationPlan = {
      mode: 'relink', sourcePath: 'Source.md', sourceOriginalContent: 'Source.',
      destinationAbsolutePath: null, destinationRelativePath: null, destinationContent: null,
      backlinkEdits: [], outgoingLinksRewritten: 0, backlinksRewritten: 0, skipped: [],
      indexMutations: [{ kind: 'upsert', vaultId: 'ideas', relativePath: 'Index.md' }],
    } as never;

    const result = await controller.execute(migrationPlan);

    expect(result).toMatchObject({
      mode: 'relink', indexUpdated: false, indexError: 'cache unavailable',
    });
    expect(io.source.get('Source.md')).toBe('Source.');
  });
});
