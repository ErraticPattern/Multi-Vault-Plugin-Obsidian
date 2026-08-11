import { TFile, type App } from 'obsidian';
import { access, mkdir, open, readFile, rename, rm, writeFile } from 'fs/promises';
import * as path from 'path';
import { randomBytes } from 'crypto';
import { DestinationOwnershipError, StaleMigrationPlanError, type MigrationIo } from './migration-transaction';

export class ObsidianMigrationIo implements MigrationIo {
  constructor(private readonly app: App) {}

  async destinationExists(absolutePath: string): Promise<boolean> {
    try {
      await access(absolutePath);
      return true;
    } catch {
      return false;
    }
  }

  async readDestination(absolutePath: string): Promise<string> {
    return readFile(absolutePath, 'utf8');
  }

  async writeDestination(
    absolutePath: string,
    content: string,
    expectedOriginal: string | null,
  ): Promise<void> {
    await mkdir(path.dirname(absolutePath), { recursive: true });
    if (expectedOriginal === null) {
      const handle = await open(absolutePath, 'wx');
      let closed = false;
      try {
        await handle.writeFile(content, { encoding: 'utf8' });
        await handle.close();
        closed = true;
      } catch (error: unknown) {
        if (!closed) await handle.close().catch(() => undefined);
        await rm(absolutePath, { force: true }).catch(() => undefined);
        throw error;
      }
      return;
    }

    const stagePath = `${absolutePath}.mvp-stage-${randomBytes(8).toString('hex')}`;
    try {
      await writeFile(stagePath, content, 'utf8');
      const current = await readFile(absolutePath, 'utf8').catch(() => null);
      if (current !== expectedOriginal) {
        throw new StaleMigrationPlanError(absolutePath);
      }
      await rename(stagePath, absolutePath);
    } catch (error: unknown) {
      await rm(stagePath, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  async restoreDestination(
    absolutePath: string,
    writtenContent: string,
    originalContent: string | null,
  ): Promise<void> {
    const current = await readFile(absolutePath, 'utf8').catch(() => null);
    if (current === writtenContent) {
      if (originalContent === null) {
        await rm(absolutePath, { force: true });
        return;
      }
      await writeFile(absolutePath, originalContent, 'utf8');
      return;
    }
    if (current === originalContent) {
      return;
    }
    throw new DestinationOwnershipError(absolutePath);
  }

  async readSourceFile(vaultPath: string): Promise<string> {
    const file = this.getSourceMarkdownFile(vaultPath);
    return this.app.vault.read(file);
  }

  async writeSourceFile(vaultPath: string, content: string): Promise<void> {
    const file = this.getSourceMarkdownFile(vaultPath);
    await this.app.vault.modify(file, content);
  }

  async trashSourceFile(vaultPath: string): Promise<void> {
    const file = this.getSourceMarkdownFile(vaultPath);
    await this.app.fileManager.trashFile(file);
  }

  async restoreSourceFile(vaultPath: string, content: string): Promise<void> {
    const existing = this.app.vault.getAbstractFileByPath(vaultPath);
    if (existing instanceof TFile) {
      await this.app.vault.modify(existing, content);
      return;
    }
    await this.app.vault.create(vaultPath, content);
  }

  private getSourceMarkdownFile(vaultPath: string): TFile {
    const file = this.app.vault.getAbstractFileByPath(vaultPath);
    if (!(file instanceof TFile)) throw new Error(`Source file not found: ${vaultPath}`);
    if (file.extension.toLowerCase() !== 'md') {
      throw new Error(`Source file is not Markdown: ${vaultPath}`);
    }
    return file;
  }
}
