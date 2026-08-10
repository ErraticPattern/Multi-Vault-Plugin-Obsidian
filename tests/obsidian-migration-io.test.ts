import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { TFile } from 'obsidian';
import { ObsidianMigrationIo } from '../src/migration/obsidian-migration-io';

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
    await io.writeDestination(destination, 'destination');
    expect(await io.destinationExists(destination)).toBe(true);
    expect(await io.readDestination(destination)).toBe('destination');
    expect(await io.readSourceFile(sourceFile.path)).toBe('original');
    await io.writeSourceFile(sourceFile.path, 'updated');
    expect(files.get(sourceFile.path)).toBe('updated');
    await io.trashSourceFile(sourceFile.path);
    expect(trashed).toBe(sourceFile.path);
    await io.restoreSourceFile('Notes/Restored.md', 'restored');
    expect(files.get('Notes/Restored.md')).toBe('restored');
    await io.removeDestination(destination);
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
});
