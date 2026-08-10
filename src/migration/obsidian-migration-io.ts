import { TFile, type App } from 'obsidian';
import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import type { MigrationIo } from './migration-transaction';

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

  async writeDestination(absolutePath: string, content: string): Promise<void> {
    await mkdir(path.dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, content, { encoding: 'utf8', flag: 'wx' });
  }

  async removeDestination(absolutePath: string): Promise<void> {
    await rm(absolutePath, { force: true });
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

  private getSourceMarkdownFile(vaultPath: string): TFile {
    const file = this.app.vault.getAbstractFileByPath(vaultPath);
    if (!(file instanceof TFile)) throw new Error(`Source file not found: ${vaultPath}`);
    if (file.extension.toLowerCase() !== 'md') {
      throw new Error(`Source file is not Markdown: ${vaultPath}`);
    }
    return file;
  }
}
