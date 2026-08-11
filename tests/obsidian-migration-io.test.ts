import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import {
  lstat as lstatViaProdSpecifier,
  open as openViaProdSpecifier,
  readFile as readFileViaProdSpecifier,
  writeFile as writeFileViaProdSpecifier,
} from 'fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { TFile } from 'obsidian';
import { DestinationOwnershipError, StaleMigrationPlanError } from '../src/migration/migration-transaction';
import { ObsidianMigrationIo } from '../src/migration/obsidian-migration-io';

vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs/promises')>();
  return {
    ...actual,
    lstat: vi.fn(actual.lstat),
    open: vi.fn(actual.open),
    readFile: vi.fn(actual.readFile),
    writeFile: vi.fn(actual.writeFile),
  };
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
    const destinationOwnership = await io.writeDestination(destination, 'destination', null);
    expect(await io.destinationExists(destination)).toBe(true);
    expect(await io.readDestination(destination)).toBe('destination');
    expect(await io.readSourceFile(sourceFile.path)).toBe('original');
    await io.writeSourceFile(sourceFile.path, 'updated');
    expect(files.get(sourceFile.path)).toBe('updated');
    await io.trashSourceFile(sourceFile.path);
    expect(trashed).toBe(sourceFile.path);
    await io.restoreSourceFile('Notes/Restored.md', 'restored');
    expect(files.get('Notes/Restored.md')).toBe('restored');
    await io.restoreDestination(destination, destinationOwnership);
    expect(await io.destinationExists(destination)).toBe(false);
    await expect(readFile(`${destination}.bak`)).rejects.toThrow();
  });

  it('propagates non-ENOENT errors while checking destination existence', async () => {
    const io = new ObsidianMigrationIo({ vault: {}, fileManager: {} } as never);
    const denied = Object.assign(new Error('permission denied'), { code: 'EACCES' });
    vi.mocked(lstatViaProdSpecifier).mockRejectedValueOnce(denied);

    await expect(io.destinationExists('C:/unreadable/Existing.md')).rejects.toBe(denied);
  });

  it('propagates non-ENOENT errors while reading a destination', async () => {
    const io = new ObsidianMigrationIo({ vault: {}, fileManager: {} } as never);
    const transient = Object.assign(new Error('temporary I/O failure'), { code: 'EIO' });
    vi.mocked(readFileViaProdSpecifier).mockRejectedValueOnce(transient);

    await expect(io.readDestination('C:/unstable/Existing.md')).rejects.toBe(transient);
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

  it('leaves a same-content concurrent destination untouched when create publication gets EEXIST', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'mvn-io-'));
    roots.push(root);
    const io = new ObsidianMigrationIo({ vault: {}, fileManager: {} } as never);
    const destination = path.join(root, 'Concurrent.md');
    await writeFile(destination, 'planned content', 'utf8');

    await expect(io.writeDestination(destination, 'planned content', null))
      .rejects.toMatchObject({ code: 'EEXIST' });

    expect(await readFile(destination, 'utf8')).toBe('planned content');
    expect(await readdir(root)).toEqual(['Concurrent.md']);
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

  it('rejects a reviewed overwrite when the destination changes during staging and leaves no stage artifact', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'mvn-io-'));
    roots.push(root);
    const app = { vault: {}, fileManager: {} };
    const io = new ObsidianMigrationIo(app as never);
    const destination = path.join(root, 'Existing.md');
    await writeFile(destination, 'existing', 'utf8');

    const mockedWriteFile = vi.mocked(writeFileViaProdSpecifier);
    mockedWriteFile.mockImplementationOnce(async (filePath, data, encoding) => {
      await writeFile(filePath as string, String(data), encoding as BufferEncoding);
      if (typeof filePath === 'string' && filePath.includes('.mvp-stage-')) {
        await writeFile(destination, 'changed during staging', 'utf8');
      }
    });

    await expect(io.writeDestination(destination, 'updated', 'existing'))
      .rejects.toBeInstanceOf(StaleMigrationPlanError);

    expect(await io.readDestination(destination)).toBe('changed during staging');
    expect(await readdir(root)).toEqual(['Existing.md']);
  });

  it('refuses create cleanup when the path is replaced between validation and deletion', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'mvn-io-'));
    roots.push(root);
    const destination = path.join(root, 'Created.md');
    const displaced = path.join(root, 'Created-by-transaction.md');
    let raceInjected = false;
    const io = new ObsidianMigrationIo(
      { vault: {}, fileManager: {} } as never,
      {
        beforeCreateRemoval: async () => {
          raceInjected = true;
          await rename(destination, displaced);
          await writeFile(destination, 'transaction content', 'utf8');
        },
      },
    );
    const ownership = await io.writeDestination(destination, 'transaction content', null);

    await expect(io.restoreDestination(destination, ownership))
      .rejects.toBeInstanceOf(DestinationOwnershipError);

    expect(raceInjected).toBe(true);
    expect(await readFile(destination, 'utf8')).toBe('transaction content');
    expect(await readFile(displaced, 'utf8')).toBe('transaction content');
  });

  it('refuses overwrite restoration when the path is replaced before descriptor mutation', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'mvn-io-'));
    roots.push(root);
    const destination = path.join(root, 'Existing.md');
    const displaced = path.join(root, 'Published-by-transaction.md');
    await writeFile(destination, 'existing', 'utf8');
    let raceInjected = false;
    const io = new ObsidianMigrationIo(
      { vault: {}, fileManager: {} } as never,
      {
        beforeOverwriteRestore: async () => {
          raceInjected = true;
          await rename(destination, displaced);
          await writeFile(destination, 'updated', 'utf8');
        },
      },
    );
    const ownership = await io.writeDestination(destination, 'updated', 'existing');

    await expect(io.restoreDestination(destination, ownership))
      .rejects.toBeInstanceOf(DestinationOwnershipError);

    expect(raceInjected).toBe(true);
    expect(await readFile(destination, 'utf8')).toBe('updated');
    expect(await readFile(displaced, 'utf8')).toBe('updated');
  });

  it('propagates non-ENOENT errors while opening a published destination for rollback', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'mvn-io-'));
    roots.push(root);
    const destination = path.join(root, 'Created.md');
    const io = new ObsidianMigrationIo({ vault: {}, fileManager: {} } as never);
    const ownership = await io.writeDestination(destination, 'created', null);
    const denied = Object.assign(new Error('permission denied'), { code: 'EACCES' });
    vi.mocked(openViaProdSpecifier).mockRejectedValueOnce(denied);

    await expect(io.restoreDestination(destination, ownership)).rejects.toBe(denied);
    expect(await readFile(destination, 'utf8')).toBe('created');
  });

  it('rejects stale same-content publication without returning rollback ownership', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'mvn-io-'));
    roots.push(root);
    const destination = path.join(root, 'Existing.md');
    const io = new ObsidianMigrationIo(
      { vault: {}, fileManager: {} } as never,
      {
        beforeOverwritePublication: async () => {
          await writeFile(destination, 'updated', 'utf8');
        },
      },
    );
    await writeFile(destination, 'existing', 'utf8');

    await expect(io.writeDestination(destination, 'updated', 'existing'))
      .rejects.toBeInstanceOf(StaleMigrationPlanError);

    expect(await readFile(destination, 'utf8')).toBe('updated');
    expect(await readdir(root)).toEqual(['Existing.md']);
  });

  it('restores the original content of an overwritten destination', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'mvn-io-'));
    roots.push(root);
    const app = { vault: {}, fileManager: {} };
    const io = new ObsidianMigrationIo(app as never);
    const destination = path.join(root, 'Existing.md');
    await writeFile(destination, 'existing', 'utf8');
    const ownership = await io.writeDestination(destination, 'updated', 'existing');

    await io.restoreDestination(destination, ownership);

    expect(await io.readDestination(destination)).toBe('existing');
  });

  it('refuses to restore a destination whose content no longer matches what was written', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'mvn-io-'));
    roots.push(root);
    const app = { vault: {}, fileManager: {} };
    const io = new ObsidianMigrationIo(app as never);
    const destination = path.join(root, 'Existing.md');
    await writeFile(destination, 'existing', 'utf8');
    const ownership = await io.writeDestination(destination, 'updated', 'existing');
    await writeFile(destination, 'tampered by another process', 'utf8');

    await expect(io.restoreDestination(destination, ownership))
      .rejects.toBeInstanceOf(DestinationOwnershipError);
    expect(await io.readDestination(destination)).toBe('tampered by another process');
  });

  it('reports ownership loss when a published destination is absent during rollback', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'mvn-io-'));
    roots.push(root);
    const app = { vault: {}, fileManager: {} };
    const io = new ObsidianMigrationIo(app as never);
    const destination = path.join(root, 'Removed.md');
    const ownership = await io.writeDestination(destination, 'created', null);
    await rm(destination);

    await expect(io.restoreDestination(destination, ownership))
      .rejects.toBeInstanceOf(DestinationOwnershipError);
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
