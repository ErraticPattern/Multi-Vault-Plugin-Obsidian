import { App } from 'obsidian';
import { IndexCache, IndexedFile } from '../types';
import { VaultRegistry } from '../vault-registry';
import { rebaseRelativePath } from '../vault-paths';

export class IndexStore {
  private app: App;
  private readonly CACHE_FILE = 'index-cache.json';

  constructor(app: App) {
    this.app = app;
  }

  public async saveIndex(files: IndexedFile[], storeSnippets: boolean = true): Promise<void> {
    const filesToCache = storeSnippets ? files : files.map(f => {
      const copy = { ...f };
      delete copy.contentPreview;
      return copy;
    });

    const cache: IndexCache = {
      version: 2,
      generatedAt: new Date().toISOString(),
      files: filesToCache
    };

    const dataPath = this.getPluginDataPath();
    if (dataPath) {
      // Obsidian's adapter handles vault-relative paths
      // The plugin data folder is at .obsidian/plugins/multi-vault-navigator
      const pluginDir = this.app.vault.configDir + '/plugins/multi-vault-navigator';
      const filePath = `${pluginDir}/${this.CACHE_FILE}`;
      
      // We must ensure the dir exists, though it should if settings are saved
      const exists = await this.app.vault.adapter.exists(pluginDir);
      if (!exists) {
        await this.app.vault.adapter.mkdir(pluginDir);
      }
      
      await this.app.vault.adapter.write(filePath, JSON.stringify(cache));
    }
  }

  public async loadIndex(registry: VaultRegistry): Promise<{ files: IndexedFile[]; migrated: boolean }> {
    const dataPath = this.getPluginDataPath();
    if (dataPath) {
      const pluginDir = this.app.vault.configDir + '/plugins/multi-vault-navigator';
      const filePath = `${pluginDir}/${this.CACHE_FILE}`;
      
      try {
        const exists = await this.app.vault.adapter.exists(filePath);
        if (exists) {
          const content = await this.app.vault.adapter.read(filePath);
          const cache = JSON.parse(content) as IndexCache;
          if (cache.version === 2) {
            const aliases = registry.getIdAliases();
            let migrated = false;
            const files: IndexedFile[] = [];
            for (const cached of cache.files || []) {
              let vaultId = cached.vaultId;
              const visited = new Set<string>();
              while (aliases.has(vaultId) && !visited.has(vaultId)) {
                visited.add(vaultId);
                vaultId = aliases.get(vaultId)!;
              }
              const relativePath = cached.relativePath.replace(/\\/g, '/');
              const vault = registry.getVaultById(vaultId);
              let absolutePath = cached.absolutePath;
              if (vault?.available) {
                const rebased = rebaseRelativePath(vault.path, relativePath);
                if (!rebased) { migrated = true; continue; }
                absolutePath = rebased;
              }
              if (vaultId !== cached.vaultId || relativePath !== cached.relativePath || absolutePath !== cached.absolutePath) migrated = true;
              files.push({ ...cached, vaultId, relativePath, absolutePath });
            }
            return { files, migrated };
          }
        }
      } catch {
        return { files: [], migrated: false };
      }
    }
    return { files: [], migrated: false };
  }

  public async clearIndex(): Promise<void> {
    const pluginDir = this.app.vault.configDir + '/plugins/multi-vault-navigator';
    const filePath = `${pluginDir}/${this.CACHE_FILE}`;
    try {
      const exists = await this.app.vault.adapter.exists(filePath);
      if (exists) {
        await this.app.vault.adapter.remove(filePath);
      }
    } catch {
      return;
    }
  }

  private getPluginDataPath(): string | null {
    // using Obsidian's built-in configDir
    return this.app.vault.configDir;
  }
}
