import { App, Notice } from 'obsidian';
import { VaultRegistry } from '../vault-registry';
import { FileScanner, type FileEntry } from './file-scanner';
import { MarkdownParser } from './markdown-parser';
import { IndexStore } from './index-store';
import { IndexedFile, MultiVaultSettings, type VaultConfig } from '../types';
import { deduplicateMutations, type IndexMutation } from './index-mutations';

export interface IndexerDependencies {
  scanner: FileScanner;
  parser: MarkdownParser;
  store: IndexStore;
}

interface ScannedFile {
  entry: FileEntry;
  vault: VaultConfig;
}

export class Indexer {
  private readonly scanner: FileScanner;
  private readonly parser: MarkdownParser;
  private readonly store: IndexStore;
  private indexedFiles: IndexedFile[] = [];
  private refreshPromise: Promise<void> | null = null;
  private rebuildPromise: Promise<void> | null = null;
  private operationTail: Promise<void> = Promise.resolve();

  constructor(
    private readonly app: App,
    private readonly vaultRegistry: VaultRegistry,
    private readonly settings: MultiVaultSettings,
    dependencies: Partial<IndexerDependencies> = {},
  ) {
    this.scanner = dependencies.scanner ?? new FileScanner(settings.indexOptions.globalExcludePatterns || []);
    this.parser = dependencies.parser ?? new MarkdownParser(settings.indexOptions.maxPreviewChars);
    this.store = dependencies.store ?? new IndexStore(app);
  }

  public async initialize(): Promise<void> {
    this.indexedFiles = await this.store.loadIndex();
  }

  public getIndexedFiles(): IndexedFile[] {
    return this.indexedFiles;
  }

  public async applyMutations(mutations: IndexMutation[]): Promise<void> {
    if (mutations.length === 0) return;
    return this.enqueue(() => this.performMutations(mutations));
  }

  public refreshIncremental(showNotice = false): Promise<void> {
    if (this.refreshPromise) return this.refreshPromise;
    const operation = this.enqueue(() => this.performIncrementalRefresh(showNotice));
    const settled = operation.finally(() => {
      if (this.refreshPromise === settled) this.refreshPromise = null;
    });
    this.refreshPromise = settled;
    return settled;
  }

  public buildFullIndex(showNotice = false): Promise<void> {
    if (this.rebuildPromise) {
      if (showNotice) new Notice('Indexing is already in progress...');
      return this.rebuildPromise;
    }
    const operation = this.enqueue(() => this.performFullRebuild(showNotice));
    const settled = operation.finally(() => {
      if (this.rebuildPromise === settled) this.rebuildPromise = null;
    });
    this.rebuildPromise = settled;
    return settled;
  }

  public async clearIndex(): Promise<void> {
    await this.enqueue(async () => {
      await this.store.clearIndex();
      this.indexedFiles = [];
    });
    new Notice('Index cleared.');
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationTail.then(operation, operation);
    this.operationTail = result.then(() => undefined, () => undefined);
    return result;
  }

  private async performMutations(mutations: IndexMutation[]): Promise<void> {
    const filesByIdentity = new Map(this.indexedFiles.map((file) => [
      this.identity(file.vaultId, file.relativePath),
      file,
    ]));
    for (const mutation of deduplicateMutations(mutations)) {
      const identity = this.identity(mutation.vaultId, mutation.relativePath);
      if (mutation.kind === 'remove') {
        filesByIdentity.delete(identity);
        continue;
      }
      const vault = this.vaultRegistry.getVaultById(mutation.vaultId);
      if (!vault) throw new Error(`Vault is not configured: ${mutation.vaultId}`);
      if (!this.scanner.isPathIncluded(vault, mutation.relativePath)) {
        filesByIdentity.delete(identity);
        continue;
      }
      const entry = await this.scanner.scanFileAsync(vault, mutation.relativePath);
      if (!entry) {
        throw new Error(`Upserted index file could not be read: ${vault.name}/${mutation.relativePath}`);
      }
      const indexed = await this.parser.parseMarkdownFileAsync(entry, vault);
      filesByIdentity.set(identity, indexed);
    }
    await this.commit([...filesByIdentity.values()]);
  }

  private async performIncrementalRefresh(showNotice: boolean): Promise<void> {
    if (showNotice) new Notice('Refreshing changed cross-vault index entries...');
    try {
      const scanned = await this.scanEnabledVaults();
      const existing = new Map(this.indexedFiles.map((file) => [
        this.identity(file.vaultId, file.relativePath),
        file,
      ]));
      const scannedIdentities = new Set<string>();
      const unchanged: IndexedFile[] = [];
      const changed: ScannedFile[] = [];
      for (const item of scanned) {
        const identity = this.identity(item.vault.id, item.entry.relativePath);
        scannedIdentities.add(identity);
        const previous = existing.get(identity);
        if (previous && previous.mtime === item.entry.mtime && previous.size === item.entry.size) {
          unchanged.push(previous);
        } else {
          changed.push(item);
        }
      }
      const removedCount = [...existing.keys()]
        .filter((identity) => !scannedIdentities.has(identity)).length;
      const parsed = await this.parseScannedFiles(changed);
      if (changed.length > 0 || removedCount > 0) {
        await this.commit([...unchanged, ...parsed]);
      }
      if (showNotice) {
        new Notice(`Cross-vault index refreshed: ${changed.length} changed, ` +
          `${removedCount} removed.`);
      }
    } catch (error: unknown) {
      if (showNotice) {
        new Notice(`Failed to refresh index: ${error instanceof Error ? error.message : String(error)}`);
      }
      throw error;
    }
  }

  private async performFullRebuild(showNotice: boolean): Promise<void> {
    if (showNotice) new Notice('Starting cross-vault index build...');
    try {
      const enabledVaults = this.vaultRegistry.getEnabledVaults();
      const scanned = await this.scanEnabledVaults();
      const rebuilt = await this.parseScannedFiles(scanned);
      await this.commit(rebuilt);
      if (showNotice) {
        new Notice(`Index built successfully! ${this.indexedFiles.length} files indexed across ` +
          `${enabledVaults.length} vaults.`);
      }
    } catch (error: unknown) {
      if (showNotice) {
        new Notice(`Failed to build index: ${error instanceof Error ? error.message : String(error)}`);
      }
      throw error;
    }
  }

  private async scanEnabledVaults(): Promise<ScannedFile[]> {
    const enabledVaults = this.vaultRegistry.getEnabledVaults();
    const scans = await Promise.all(enabledVaults.map(async (vault) => ({
      vault,
      entries: await this.scanner.scanVaultAsync(vault),
    })));
    return scans.flatMap(({ vault, entries }) => entries.map((entry) => ({ vault, entry })));
  }

  private async parseScannedFiles(files: ScannedFile[]): Promise<IndexedFile[]> {
    if (files.length === 0) return [];
    const results = new Array<IndexedFile>(files.length);
    let nextIndex = 0;
    const worker = async (): Promise<void> => {
      while (nextIndex < files.length) {
        const index = nextIndex;
        nextIndex += 1;
        const { entry, vault } = files[index];
        results[index] = await this.parser.parseMarkdownFileAsync(entry, vault);
      }
    };
    const workerCount = Math.min(8, files.length);
    await Promise.all(Array.from({ length: workerCount }, () => worker()));
    return results;
  }

  private async commit(files: IndexedFile[]): Promise<void> {
    await this.store.saveIndex(
      files,
      this.settings.indexOptions.storeSnippetsInCache !== false,
    );
    this.indexedFiles = files;
  }

  private identity(vaultId: string, relativePath: string): string {
    return `${vaultId}:${relativePath.replace(/\\/g, '/').toLowerCase()}`;
  }
}
