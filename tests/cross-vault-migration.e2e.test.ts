import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { mkdir, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { planMoveOrCopy, planStandaloneRelink, type LinkSnapshot, type NoteSnapshot } from '../src/migration/migration-planner';
import { executeMigrationPlan, type MigrationIo } from '../src/migration/migration-transaction';

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
  async writeDestination(absolutePath: string, content: string): Promise<void> {
    await mkdir(path.dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, content, { flag: 'wx' });
  }
  async removeDestination(absolutePath: string): Promise<void> { await rm(absolutePath, { force: true }); }
  async readSourceFile(vaultPath: string): Promise<string> {
    return readFile(path.join(this.sourceRoot, vaultPath), 'utf8');
  }
  async writeSourceFile(vaultPath: string, content: string): Promise<void> {
    await writeFile(path.join(this.sourceRoot, vaultPath), content);
  }
  async trashSourceFile(vaultPath: string): Promise<void> {
    await unlink(path.join(this.sourceRoot, vaultPath));
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
});
