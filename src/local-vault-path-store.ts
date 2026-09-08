import * as fs from 'fs';
import * as path from 'path';

export interface LocalVaultPathData { version: 1; vaultPaths: Record<string, string> }
export interface LocalPathFileSystem {
  existsSync(value: string): boolean;
  readFileSync(value: string, encoding: 'utf8'): string;
  mkdirSync(value: string, options: { recursive: true }): unknown;
  writeFileSync(value: string, data: string, encoding: 'utf8'): void;
  renameSync(from: string, to: string): void;
  unlinkSync(value: string): void;
}

export class LocalVaultPathStore {
  private data: LocalVaultPathData = { version: 1, vaultPaths: {} };
  constructor(private readonly filePath: string, private readonly fileSystem: LocalPathFileSystem = fs) {}

  load(): LocalVaultPathData {
    try {
      if (!this.fileSystem.existsSync(this.filePath)) return this.snapshot();
      const value = JSON.parse(this.fileSystem.readFileSync(this.filePath, 'utf8')) as Partial<LocalVaultPathData>;
      if (value.version === 1 && value.vaultPaths && typeof value.vaultPaths === 'object') {
        this.data = { version: 1, vaultPaths: { ...value.vaultPaths } };
      }
    } catch (error) {
      console.error(`Multi-Vault Navigator: failed to read local paths: ${this.filePath}`, error);
    }
    return this.snapshot();
  }

  get(vaultId: string): string | undefined { return this.data.vaultPaths[vaultId]; }
  set(vaultId: string, vaultPath: string): void { this.persist({ ...this.data.vaultPaths, [vaultId]: vaultPath }); }
  remove(vaultId: string): void {
    const next = { ...this.data.vaultPaths };
    delete next[vaultId];
    this.persist(next);
  }

  private snapshot(): LocalVaultPathData { return { version: 1, vaultPaths: { ...this.data.vaultPaths } }; }
  private persist(vaultPaths: Record<string, string>): void {
    const next: LocalVaultPathData = { version: 1, vaultPaths };
    const temporary = `${this.filePath}.tmp`;
    this.fileSystem.mkdirSync(path.dirname(this.filePath), { recursive: true });
    try {
      this.fileSystem.writeFileSync(temporary, JSON.stringify(next, null, 2), 'utf8');
      this.fileSystem.renameSync(temporary, this.filePath);
      this.data = next;
    } catch (error) {
      try { if (this.fileSystem.existsSync(temporary)) this.fileSystem.unlinkSync(temporary); } catch { /* preserve original error */ }
      throw error;
    }
  }
}
