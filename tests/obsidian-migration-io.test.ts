import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { writeFile as writeFileViaProdSpecifier } from 'fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { TFile } from 'obsidian';
import { DestinationOwnershipError, StaleMigrationPlanError } from '../src/migration/migration-transaction';
import { ObsidianMigrationIo } from '../src/migration/obsidian-migration-io';

vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs/promises')>();
  return { ...actual, writeFile: vi.fn(actual.writeFile) };
});

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

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

describe('ObsidianMigrationIo', () => {
  it('adapts source-vault files and external destination files without backups', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'mvn-io-'));
    roots.push(root);
    const sourceFile = testFile('Notes/Source.md');
    const files = new Map([[sourceFile.path, 'original']]);
    const abstractFiles = new Map([[sourceFile.path, sourceFile]]);
    let trashed: string | null = null;
    const app = {
      vault: {
        getAbstractFileByPath: (vaultPath: string) => abstractFiles.get(vaultPath) ?? null,
        read: async (file: TFile) => files.get(file.path)!,
        modify: async (file: TFile, content: string) => { files.set(file.path, content); },
        create: async (vaultPath: string, content: string) => {
          const created = testFile(vaultPath);
          abstractFiles.set(vaultPath, created);
          files.set(vaultPath, content);
          return created;
        },
      },
      fileManager: {
        trashFile: async (file: TFile) => { trashed = file.path; },
      },
    };
    const io = new ObsidianMigrationIo(app as never);
    const destination = path.join(root, 'Nested', 'Source.md');

    expect(await io.destinationExists(destination)).toBe(false);
    await io.writeDestination(destination, 'destination', null);
    expect(await io.destinationExists(destination)).toBe(true);
    expect(await io.readDestination(destination)).toBe('destination');
    expect(await io.readSourceFile(sourceFile.path)).toBe('original');
    await io.writeSourceFile(sourceFile.path, 'updated');
    expect(files.get(sourceFile.path)).toBe('updated');
    await io.trashSourceFile(sourceFile.path);
    expect(trashed).toBe(sourceFile.path);
    await io.restoreSourceFile('Notes/Restored.md', 'restored');
    expect(files.get('Notes/Restored.md')).toBe('restored');
    await io.restoreDestination(destination, 'destination', null);
    expect(await io.destinationExists(destination)).toBe(false);
    await expect(readFile(`${destination}.bak`)).rejects.toThrow();
  });

  it('rejects missing and non-Markdown source files', async () => {
    const image = testFile('Attachments/image.png');
    const app = {
      vault: {
        getAbstractFileByPath: (vaultPath: string) => vaultPath === image.path ? image : null,
      },
      fileManager: {},
    };
    const io = new ObsidianMigrationIo(app as never);

    await expect(io.readSourceFile('Missing.md')).rejects.toThrow(/not found/i);
    await expect(io.readSourceFile(image.path)).rejects.toThrow(/Markdown/i);
  });

  it('overwrites a destination only when the current content matches the expected original', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'mvn-io-'));
    roots.push(root);
    const app = { vault: {}, fileManager: {} };
    const io = new ObsidianMigrationIo(app as never);
    const destination = path.join(root, 'Existing.md');
    await writeFile(destination, 'existing', 'utf8');

    await io.writeDestination(destination, 'updated', 'existing');

    expect(await io.readDestination(destination)).toBe('updated');
  });

  it('rejects an overwrite when the destination no longer matches the expected original', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'mvn-io-'));
    roots.push(root);
    const app = { vault: {}, fileManager: {} };
    const io = new ObsidianMigrationIo(app as never);
    const destination = path.join(root, 'Existing.md');
    await writeFile(destination, 'changed after review', 'utf8');

    await expect(io.writeDestination(destination, 'updated', 'existing'))
      .rejects.toBeInstanceOf(StaleMigrationPlanError);
    expect(await io.readDestination(destination)).toBe('changed after review');
  });

  it('restores the original content of an overwritten destination', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'mvn-io-'));
    roots.push(root);
    const app = { vault: {}, fileManager: {} };
    const io = new ObsidianMigrationIo(app as never);
    const destination = path.join(root, 'Existing.md');
    await writeFile(destination, 'existing', 'utf8');
    await io.writeDestination(destination, 'updated', 'existing');

    await io.restoreDestination(destination, 'updated', 'existing');

    expect(await io.readDestination(destination)).toBe('existing');
  });

  it('refuses to restore a destination whose content no longer matches what was written', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'mvn-io-'));
    roots.push(root);
    const app = { vault: {}, fileManager: {} };
    const io = new ObsidianMigrationIo(app as never);
    const destination = path.join(root, 'Existing.md');
    await writeFile(destination, 'tampered by another process', 'utf8');

    await expect(io.restoreDestination(destination, 'updated', 'existing'))
      .rejects.toBeInstanceOf(DestinationOwnershipError);
    expect(await io.readDestination(destination)).toBe('tampered by another process');
  });

  it('treats an already-absent destination as successfully restored when it was never created', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'mvn-io-'));
    roots.push(root);
    const app = { vault: {}, fileManager: {} };
    const io = new ObsidianMigrationIo(app as never);
    const destination = path.join(root, 'NeverCreated.md');

    await expect(io.restoreDestination(destination, 'content that failed to write', null))
      .resolves.toBeUndefined();
    expect(await io.destinationExists(destination)).toBe(false);
  });

  it('leaves the original destination untouched when a mid-overwrite write fails', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'mvn-io-'));
    roots.push(root);
    const app = { vault: {}, fileManager: {} };
    const io = new ObsidianMigrationIo(app as never);
    const destination = path.join(root, 'Existing.md');
    await writeFile(destination, 'existing', 'utf8');

    const mockedWriteFile = vi.mocked(writeFileViaProdSpecifier);
    mockedWriteFile.mockImplementationOnce(async (filePath, data, encoding) => {
      await writeFile(filePath as string, String(data).slice(0, 2), encoding as BufferEncoding);
      throw new Error('disk full');
    });
    try {
      await expect(io.writeDestination(destination, 'updated', 'existing'))
        .rejects.toThrow('disk full');
    } finally {
      mockedWriteFile.mockClear();
    }

    expect(await io.readDestination(destination)).toBe('existing');
    const entries = await readdir(root);
    expect(entries).toEqual(['Existing.md']);
  });
});
