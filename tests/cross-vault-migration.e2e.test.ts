import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { mkdir, readFile, readdir, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { TFile } from 'obsidian';
import { planMoveOrCopy, planStandaloneRelink, type LinkSnapshot, type NoteSnapshot } from '../src/migration/migration-planner';
import { ObsidianMigrationIo } from '../src/migration/obsidian-migration-io';
import {
  executeMigrationPlan,
  type DestinationOwnershipToken,
  type MigrationIo,
} from '../src/migration/migration-transaction';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

class FixtureIo implements MigrationIo {
  constructor(private sourceRoot: string) {}
  async destinationExists(absolutePath: string): Promise<boolean> {
    try { await readFile(absolutePath); return true; } catch { return false; }
  }
  async readDestination(absolutePath: string): Promise<string> { return readFile(absolutePath, 'utf8'); }
  async writeDestination(
    absolutePath: string,
    content: string,
    expectedOriginal: string | null,
  ): Promise<DestinationOwnershipToken> {
    await mkdir(path.dirname(absolutePath), { recursive: true });
    if (expectedOriginal === null) {
      await writeFile(absolutePath, content, { flag: 'wx' });
    } else {
      await writeFile(absolutePath, content, 'utf8');
    }
    return { originalContent: expectedOriginal } as unknown as DestinationOwnershipToken;
  }
  async restoreDestination(absolutePath: string, ownership: DestinationOwnershipToken): Promise<void> {
    const { originalContent } = ownership as unknown as { originalContent: string | null };
    if (originalContent === null) {
      await rm(absolutePath, { force: true });
      return;
    }
    await writeFile(absolutePath, originalContent, 'utf8');
  }
  async readSourceFile(vaultPath: string): Promise<string> {
    return readFile(path.join(this.sourceRoot, vaultPath), 'utf8');
  }
  async writeSourceFile(vaultPath: string, content: string): Promise<void> {
    await writeFile(path.join(this.sourceRoot, vaultPath), content);
  }
  async trashSourceFile(vaultPath: string): Promise<void> {
    await unlink(path.join(this.sourceRoot, vaultPath));
  }
  async restoreSourceFile(vaultPath: string, content: string): Promise<void> {
    const absolutePath = path.join(this.sourceRoot, vaultPath);
    await mkdir(path.dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, content);
  }
}

function reference(
  sourcePath: string,
  content: string,
  original: string,
  linkTarget: string,
  resolvedPath: string,
): LinkSnapshot {
  const startOffset = content.indexOf(original);
  return {
    sourcePath,
    original,
    linkTarget,
    startOffset,
    endOffset: startOffset + original.length,
    resolvedPath,
    kind: 'wikilink',
  };
}

function testFile(filePath: string): TFile {
  const file = new TFile();
  const name = filePath.split('/').pop() ?? filePath;
  const dot = name.lastIndexOf('.');
  Object.assign(file, {
    path: filePath,
    name,
    extension: dot === -1 ? '' : name.slice(dot + 1),
    basename: dot === -1 ? name : name.slice(0, dot),
  });
  return file;
}

async function collectFiles(root: string, relative = ''): Promise<string[]> {
  const absolute = relative ? path.join(root, relative) : root;
  const entries = await readdir(absolute, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const nextRelative = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      files.push(...await collectFiles(root, nextRelative));
      continue;
    }
    files.push(nextRelative);
  }
  return files;
}

async function assertNoTemporaryArtifacts(...roots: string[]): Promise<void> {
  const files = (await Promise.all(roots.map((root) => collectFiles(root)))).flat();
  expect(files.some((file) => /\.(?:bak|backup|tmp)$/i.test(file) || /\.mvp-stage-/i.test(file))).toBe(false);
}

function createDisposableVaultIo(
  sourceRoot: string,
  abstractFiles: Map<string, TFile>,
  failTrashAfterDelete = false,
): ObsidianMigrationIo {
  const app = {
    vault: {
      getAbstractFileByPath: (vaultPath: string) => abstractFiles.get(vaultPath) ?? null,
      read: async (file: TFile) => readFile(path.join(sourceRoot, file.path), 'utf8'),
      modify: async (file: TFile, content: string) => {
        const absolutePath = path.join(sourceRoot, file.path);
        await mkdir(path.dirname(absolutePath), { recursive: true });
        await writeFile(absolutePath, content, 'utf8');
      },
      create: async (vaultPath: string, content: string) => {
        const absolutePath = path.join(sourceRoot, vaultPath);
        await mkdir(path.dirname(absolutePath), { recursive: true });
        await writeFile(absolutePath, content, 'utf8');
        const file = testFile(vaultPath);
        abstractFiles.set(vaultPath, file);
        return file;
      },
    },
    fileManager: {
      trashFile: async (file: TFile) => {
        const absolutePath = path.join(sourceRoot, file.path);
        await unlink(absolutePath);
        abstractFiles.delete(file.path);
        if (failTrashAfterDelete) {
          throw new Error('trash reported failure after delete');
        }
      },
    },
  };
  return new ObsidianMigrationIo(app as never);
}

async function writeTrackedFile(
  root: string,
  abstractFiles: Map<string, TFile>,
  vaultPath: string,
  content: string,
): Promise<void> {
  const absolutePath = path.join(root, vaultPath);
  await mkdir(path.dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, content, 'utf8');
  abstractFiles.set(vaultPath, testFile(vaultPath));
}

async function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'mvn-e2e-'));
  temporaryRoots.push(root);
  const ideas = path.join(root, 'ideas');
  const mathematics = path.join(root, 'mathematics');
  for (const directory of [
    path.join(ideas, '.obsidian'),
    path.join(ideas, 'Projects'),
    path.join(ideas, 'Notes'),
    path.join(mathematics, '.obsidian'),
    path.join(mathematics, 'Notes'),
  ]) await mkdir(directory, { recursive: true });

  const source = 'Uses [[EEG#Acquisition|EEG setup]].';
  const eeg = 'EEG content.';
  const backlink = 'See [[Zerotier|ZeroTier]].';
  await writeFile(path.join(ideas, 'Projects/Zerotier.md'), source);
  await writeFile(path.join(ideas, 'Notes/EEG.md'), eeg);
  await writeFile(path.join(ideas, 'Notes/Network index.md'), backlink);

  const notes: NoteSnapshot[] = [
    {
      path: 'Projects/Zerotier.md', basename: 'Zerotier', content: source,
      links: [reference('Projects/Zerotier.md', source, '[[EEG#Acquisition|EEG setup]]', 'EEG#Acquisition', 'Notes/EEG.md')],
    },
    { path: 'Notes/EEG.md', basename: 'EEG', content: eeg, links: [] },
    {
      path: 'Notes/Network index.md', basename: 'Network index', content: backlink,
      links: [reference('Notes/Network index.md', backlink, '[[Zerotier|ZeroTier]]', 'Zerotier', 'Projects/Zerotier.md')],
    },
  ];
  return { ideas, mathematics, notes, source, backlink };
}

async function collisionFixture(failTrashAfterDelete = false) {
  const root = mkdtempSync(path.join(tmpdir(), 'mvn-overwrite-'));
  temporaryRoots.push(root);
  const ideas = path.join(root, 'ideas');
  const mathematics = path.join(root, 'mathematics');
  for (const directory of [
    path.join(ideas, '.obsidian'),
    path.join(ideas, 'Notes'),
    path.join(mathematics, '.obsidian'),
    path.join(mathematics, 'Notes'),
  ]) await mkdir(directory, { recursive: true });

  const sourceContent = 'Uses [[EEG#Acquisition|EEG setup]].';
  const backlinkContent = 'See [[Same|Same note]].';
  const destinationContent = 'Reviewed destination.';
  const eegContent = 'EEG content.';
  const abstractFiles = new Map<string, TFile>();
  await writeTrackedFile(ideas, abstractFiles, 'Notes/Same.md', sourceContent);
  await writeTrackedFile(ideas, abstractFiles, 'Notes/Index.md', backlinkContent);
  await writeTrackedFile(ideas, abstractFiles, 'Notes/EEG.md', eegContent);
  await writeTrackedFile(mathematics, abstractFiles, 'Notes/Same.md', destinationContent);

  const notes: NoteSnapshot[] = [
    {
      path: 'Notes/Same.md', basename: 'Same', content: sourceContent,
      links: [reference('Notes/Same.md', sourceContent, '[[EEG#Acquisition|EEG setup]]', 'EEG#Acquisition', 'Notes/EEG.md')],
    },
    {
      path: 'Notes/Index.md', basename: 'Index', content: backlinkContent,
      links: [reference('Notes/Index.md', backlinkContent, '[[Same|Same note]]', 'Same', 'Notes/Same.md')],
    },
    { path: 'Notes/EEG.md', basename: 'EEG', content: eegContent, links: [] },
  ];

  const io = createDisposableVaultIo(ideas, abstractFiles, failTrashAfterDelete);
  return { ideas, mathematics, notes, sourceContent, backlinkContent, destinationContent, io };
}

describe('cross-vault migration workflow', () => {
  it('moves a note to a nested folder while preserving both link directions', async () => {
    const { ideas, mathematics, notes } = await fixture();
    const destination = path.join(mathematics, 'Notes', 'Zerotier.md');
    const plan = planMoveOrCopy({
      mode: 'move', sourcePath: 'Projects/Zerotier.md', sourceVaultName: 'ideas',
      targetVaultName: 'mathematics', destinationAbsolutePath: destination,
      destinationRelativePath: 'Notes/Zerotier.md', notes,
      sourceIndexedFiles: notes.map(({ path: relativePath, basename }) => ({ relativePath, basename })),
      targetIndexedFiles: [], preserveLinks: true,
    });

    await executeMigrationPlan(plan, new FixtureIo(ideas));

    expect(await readFile(destination, 'utf8')).toBe('Uses [[ideas::EEG#Acquisition|EEG setup]].');
    expect(await readFile(path.join(ideas, 'Notes/Network index.md'), 'utf8'))
      .toBe('See [[mathematics::Zerotier|ZeroTier]].');
    await expect(readFile(path.join(ideas, 'Projects/Zerotier.md'))).rejects.toThrow();
    expect(await readFile(path.join(ideas, 'Notes/EEG.md'), 'utf8')).toBe('EEG content.');
  });

  it('copies without changing source or backlinks', async () => {
    const { ideas, mathematics, notes, source, backlink } = await fixture();
    const destination = path.join(mathematics, 'Notes', 'Zerotier.md');
    const plan = planMoveOrCopy({
      mode: 'copy', sourcePath: 'Projects/Zerotier.md', sourceVaultName: 'ideas',
      targetVaultName: 'mathematics', destinationAbsolutePath: destination,
      destinationRelativePath: 'Notes/Zerotier.md', notes,
      sourceIndexedFiles: notes.map(({ path: relativePath, basename }) => ({ relativePath, basename })),
      targetIndexedFiles: [], preserveLinks: true,
    });

    await executeMigrationPlan(plan, new FixtureIo(ideas));

    expect(await readFile(path.join(ideas, 'Projects/Zerotier.md'), 'utf8')).toBe(source);
    expect(await readFile(path.join(ideas, 'Notes/Network index.md'), 'utf8')).toBe(backlink);
    expect(await readFile(destination, 'utf8')).toContain('[[ideas::EEG#Acquisition|EEG setup]]');
  });

  it('path-qualifies a moved root README when the target vault has another README', async () => {
    const { ideas, mathematics } = await fixture();
    const sourceContent = 'Root README.';
    const backlinkContent = 'See [[README]].';
    await writeFile(path.join(ideas, 'README.md'), sourceContent);
    await writeFile(path.join(ideas, 'Index.md'), backlinkContent);
    await mkdir(path.join(mathematics, 'Lab'), { recursive: true });
    await writeFile(path.join(mathematics, 'Lab/README.md'), 'Lab README.');
    const notes: NoteSnapshot[] = [
      { path: 'README.md', basename: 'README', content: sourceContent, links: [] },
      {
        path: 'Index.md', basename: 'Index', content: backlinkContent,
        links: [reference('Index.md', backlinkContent, '[[README]]', 'README', 'README.md')],
      },
    ];
    const destination = path.join(mathematics, 'README.md');
    const plan = planMoveOrCopy({
      mode: 'move', sourcePath: 'README.md', sourceVaultName: 'ideas',
      targetVaultName: 'mathematics', destinationAbsolutePath: destination,
      destinationRelativePath: 'README.md', notes,
      sourceIndexedFiles: [{ relativePath: 'README.md', basename: 'README' }],
      targetIndexedFiles: [{ relativePath: 'Lab/README.md', basename: 'README' }],
      preserveLinks: true,
    });

    await executeMigrationPlan(plan, new FixtureIo(ideas));

    expect(await readFile(path.join(ideas, 'Index.md'), 'utf8'))
      .toBe('See [[mathematics::/README]].');
    expect(await readFile(destination, 'utf8')).toBe(sourceContent);
    expect(await readFile(path.join(mathematics, 'Lab/README.md'), 'utf8')).toBe('Lab README.');
  });

  it('relinks to an existing note without deleting either duplicate', async () => {
    const { ideas, mathematics, notes, source } = await fixture();
    const existing = path.join(mathematics, 'Notes', 'Zerotier.md');
    await writeFile(existing, 'Existing destination.');
    const plan = planStandaloneRelink({
      sourcePath: 'Projects/Zerotier.md', targetVaultName: 'mathematics',
      targetRelativePath: 'Notes/Zerotier.md', notes,
      targetIndexedFiles: [{ relativePath: 'Notes/Zerotier.md', basename: 'Zerotier' }],
    });

    await executeMigrationPlan(plan, new FixtureIo(ideas));

    expect(await readFile(path.join(ideas, 'Projects/Zerotier.md'), 'utf8')).toBe(source);
    expect(await readFile(existing, 'utf8')).toBe('Existing destination.');
    expect(await readFile(path.join(ideas, 'Notes/Network index.md'), 'utf8'))
      .toBe('See [[mathematics::Zerotier|ZeroTier]].');
  });

  it('overwrites a reviewed destination during move and keeps backlinks and cleanup exact', async () => {
    const { ideas, mathematics, notes, destinationContent, io } = await collisionFixture();
    const destination = path.join(mathematics, 'Notes', 'Same.md');
    const plan = planMoveOrCopy({
      mode: 'move', sourcePath: 'Notes/Same.md', sourceVaultName: 'ideas',
      targetVaultName: 'mathematics', destinationAbsolutePath: destination,
      destinationRelativePath: 'Notes/Same.md', notes,
      sourceIndexedFiles: notes.map(({ path: relativePath, basename }) => ({ relativePath, basename })),
      targetIndexedFiles: [{ relativePath: 'Notes/Same.md', basename: 'Same' }],
      preserveLinks: true,
    });
    plan.destinationPolicy = 'overwrite-reviewed';
    plan.destinationOriginalContent = destinationContent;

    await executeMigrationPlan(plan, io);

    expect(await readFile(destination, 'utf8')).toBe('Uses [[ideas::EEG#Acquisition|EEG setup]].');
    expect(await readFile(path.join(ideas, 'Notes/Index.md'), 'utf8')).toBe('See [[mathematics::Same|Same note]].');
    await expect(readFile(path.join(ideas, 'Notes/Same.md'))).rejects.toThrow();
    await assertNoTemporaryArtifacts(ideas, mathematics);
  });

  it('copies over a reviewed destination while retaining the original source file', async () => {
    const { ideas, mathematics, notes, destinationContent, sourceContent, backlinkContent, io } = await collisionFixture();
    const destination = path.join(mathematics, 'Notes', 'Same.md');
    const plan = planMoveOrCopy({
      mode: 'copy', sourcePath: 'Notes/Same.md', sourceVaultName: 'ideas',
      targetVaultName: 'mathematics', destinationAbsolutePath: destination,
      destinationRelativePath: 'Notes/Same.md', notes,
      sourceIndexedFiles: notes.map(({ path: relativePath, basename }) => ({ relativePath, basename })),
      targetIndexedFiles: [{ relativePath: 'Notes/Same.md', basename: 'Same' }],
      preserveLinks: true,
    });
    plan.destinationPolicy = 'overwrite-reviewed';
    plan.destinationOriginalContent = destinationContent;

    await executeMigrationPlan(plan, io);

    expect(await readFile(path.join(ideas, 'Notes/Same.md'), 'utf8')).toBe(sourceContent);
    expect(await readFile(path.join(ideas, 'Notes/Index.md'), 'utf8')).toBe(backlinkContent);
    expect(await readFile(destination, 'utf8')).toBe('Uses [[ideas::EEG#Acquisition|EEG setup]].');
    await assertNoTemporaryArtifacts(ideas, mathematics);
  });

  it('restores the reviewed destination exactly when a later move step fails', async () => {
    const { ideas, mathematics, notes, destinationContent, sourceContent, backlinkContent, io } = await collisionFixture(true);
    const destination = path.join(mathematics, 'Notes', 'Same.md');
    const plan = planMoveOrCopy({
      mode: 'move', sourcePath: 'Notes/Same.md', sourceVaultName: 'ideas',
      targetVaultName: 'mathematics', destinationAbsolutePath: destination,
      destinationRelativePath: 'Notes/Same.md', notes,
      sourceIndexedFiles: notes.map(({ path: relativePath, basename }) => ({ relativePath, basename })),
      targetIndexedFiles: [{ relativePath: 'Notes/Same.md', basename: 'Same' }],
      preserveLinks: true,
    });
    plan.destinationPolicy = 'overwrite-reviewed';
    plan.destinationOriginalContent = destinationContent;

    await expect(executeMigrationPlan(plan, io)).rejects.toBeDefined();

    expect(await readFile(destination, 'utf8')).toBe(destinationContent);
    expect(await readFile(path.join(ideas, 'Notes/Same.md'), 'utf8')).toBe(sourceContent);
    expect(await readFile(path.join(ideas, 'Notes/Index.md'), 'utf8')).toBe(backlinkContent);
    await assertNoTemporaryArtifacts(ideas, mathematics);
  });
});
