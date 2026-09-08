import * as fs from 'fs';
import * as path from 'path';
import { AvailableVaultConfig } from '../types';

export interface FileEntry {
  absolutePath: string;
  relativePath: string;
  basename: string;
  extension: string;
  mtime: number;
  size: number;
}

export class FileScanner {
  private defaultExcludes = new Set(['.obsidian', '.trash', 'node_modules', '.git']);
  private globalExcludes: string[];

  constructor(globalExcludes: string[] = []) {
    this.globalExcludes = globalExcludes;
  }

  private isPathExcluded(vault: AvailableVaultConfig, relativePath: string): boolean {
    const lower = relativePath.replace(/\\/g, '/').toLowerCase();
    const segments = lower.split('/');
    if (segments.some((segment) => this.defaultExcludes.has(segment))) return true;
    const fileName = path.posix.basename(lower);
    return [...this.globalExcludes, ...(vault.excludePatterns || [])]
      .map((pattern) => pattern.trim().toLowerCase())
      .filter(Boolean)
      .some((pattern) => lower.includes(pattern) || fileName.includes(pattern));
  }

  public isPathIncluded(vault: AvailableVaultConfig, relativePath: string): boolean {
    if (this.isPathExcluded(vault, relativePath)) return false;
    const lower = relativePath.replace(/\\/g, '/').toLowerCase();
    const fileName = path.posix.basename(lower);
    const includes = (vault.includePatterns || [])
      .map((pattern) => pattern.trim().toLowerCase())
      .filter(Boolean);
    return includes.length === 0 ||
      includes.some((pattern) => lower.includes(pattern) || fileName.includes(pattern));
  }

  public async scanFileAsync(vault: AvailableVaultConfig, relativePath: string): Promise<FileEntry | null> {
    const normalized = relativePath.replace(/\\/g, '/');
    if (
      path.posix.isAbsolute(normalized) ||
      normalized.split('/').includes('..') ||
      !normalized.toLowerCase().endsWith('.md') ||
      !this.isPathIncluded(vault, normalized)
    ) return null;
    const root = path.resolve(vault.path);
    const absolutePath = path.resolve(root, normalized.replace(/\//g, path.sep));
    if (!absolutePath.startsWith(`${root}${path.sep}`)) return null;
    try {
      const stats = await fs.promises.stat(absolutePath);
      if (!stats.isFile()) return null;
      return {
        absolutePath,
        relativePath: normalized,
        basename: path.basename(normalized, path.extname(normalized)),
        extension: path.extname(normalized),
        mtime: stats.mtimeMs,
        size: stats.size,
      };
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  public async scanVaultAsync(vault: AvailableVaultConfig): Promise<FileEntry[]> {
    const files: FileEntry[] = [];
    const rootPath = vault.path;

    try {
      await fs.promises.access(rootPath, fs.constants.F_OK);
    } catch {
      return files;
    }

    const walk = async (dir: string) => {
      let entries;
      try {
        entries = await fs.promises.readdir(dir, { withFileTypes: true });
      } catch {
        return; // permission error or missing
      }

      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        const relativePath = path.relative(rootPath, fullPath).replace(/\\/g, '/');
        if (this.isPathExcluded(vault, relativePath)) continue;

        if (entry.isDirectory()) {
          await walk(fullPath);
        } else if (
          entry.isFile() &&
          entry.name.endsWith('.md') &&
          this.isPathIncluded(vault, relativePath)
        ) {
          try {
            const stats = await fs.promises.stat(fullPath);
            files.push({
              absolutePath: fullPath,
              relativePath,
              basename: path.basename(entry.name, '.md'),
              extension: '.md',
              mtime: stats.mtimeMs,
              size: stats.size
            });
          } catch {
            // ignore stat errors
          }
        }
      }
    };

    await walk(rootPath);
    return files;
  }
}
