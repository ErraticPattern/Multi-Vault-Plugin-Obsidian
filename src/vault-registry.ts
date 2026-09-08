import { App, FileSystemAdapter, Notice } from 'obsidian';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { AvailableVaultConfig, MultiVaultSettings, SharedVaultConfig, VaultConfig } from './types';
import { DiscoveredVault, discoverObsidianVaults } from './obsidian-vault-discovery';
import { LocalVaultPathStore } from './local-vault-path-store';
import { expandPortablePath, getObsidianConfigCandidates, normalizeVaultPath } from './vault-paths';

export interface VaultRegistryDependencies {
  platform: string; home: string; env: NodeJS.ProcessEnv;
  localPaths: LocalVaultPathStore; discoveredVaults: DiscoveredVault[]; generateId(): string;
}
export interface VaultRegistryOptions { autoDetect?: boolean; dependencies?: VaultRegistryDependencies }

export class VaultRegistry {
  private vaults = new Map<string, VaultConfig>();
  private aliases = new Map<string, string>();
  private shared: SharedVaultConfig[] = [];
  private deps: VaultRegistryDependencies;
  private autoDetect: boolean;

  constructor(private app: App, settings: MultiVaultSettings, options: VaultRegistryOptions | VaultRegistryDependencies = {}) {
    const directDependencies = 'localPaths' in options ? options : options.dependencies;
    this.autoDetect = !('autoDetect' in options) || options.autoDetect !== false;
    this.deps = directDependencies ?? this.defaultDependencies();
    this.deps.localPaths.load();
    this.reconcile(settings.vaults ?? []);
    if (this.autoDetect) { this.addUnconfiguredDiscoveries(); this.detectCurrentVault(); }
  }

  getVaults(): VaultConfig[] { return [...this.vaults.values()]; }
  getEnabledVaults(): AvailableVaultConfig[] { return this.getVaults().filter(v => v.enabled && v.available !== false); }
  getVaultById(id: string): VaultConfig | undefined { return this.vaults.get(this.aliases.get(id) ?? id); }
  getAvailableVaultById(id: string): AvailableVaultConfig | undefined { const v = this.getVaultById(id); return v && v.available !== false ? v : undefined; }
  getIdAliases(): ReadonlyMap<string, string> { return this.aliases; }
  getPersistedVaults(): SharedVaultConfig[] { return this.shared.map(({ path: _path, ...vault }) => ({ ...vault })); }

  replaceVaults(vaults: readonly SharedVaultConfig[]): void { this.vaults.clear(); this.aliases.clear(); this.shared = []; this.reconcile([...vaults]); }
  addVault(config: SharedVaultConfig & { path: string }): boolean { return this.addVaultPath(config.path, config); }
  addVaultPath(vaultPath: string, config?: SharedVaultConfig): boolean {
    const resolved = expandPortablePath(vaultPath, this.deps.env, this.deps.home);
    if (!this.validateVaultPath(resolved)) { new Notice(`Invalid vault path: ${vaultPath}`); return false; }
    const name = config?.name ?? path.basename(resolved);
    const matches = this.getVaults().filter(v => v.name.toLowerCase() === name.toLowerCase());
    if (!config && matches.length === 1) return this.relinkVault(matches[0].id, resolved);
    const shared: SharedVaultConfig = { ...config, id: config?.id ?? this.deps.generateId(), name, enabled: config?.enabled ?? true };
    this.deps.localPaths.set(shared.id, resolved); this.shared.push(shared);
    this.vaults.set(shared.id, { ...shared, path: resolved, available: true }); return true;
  }
  relinkVault(id: string, vaultPath: string): boolean {
    const canonical = this.aliases.get(id) ?? id, existing = this.vaults.get(canonical);
    const resolved = expandPortablePath(vaultPath, this.deps.env, this.deps.home);
    if (!existing || !this.validateVaultPath(resolved)) { new Notice(`Invalid vault path: ${vaultPath}`); return false; }
    this.deps.localPaths.set(canonical, resolved); this.vaults.set(canonical, { ...existing, path: resolved, available: true }); return true;
  }
  updateVault(id: string, partial: Partial<SharedVaultConfig>): void {
    const canonical = this.aliases.get(id) ?? id, index = this.shared.findIndex(v => v.id === canonical); if (index < 0) return;
    this.shared[index] = { ...this.shared[index], ...partial, id: canonical };
    const runtime = this.vaults.get(canonical); if (runtime) this.vaults.set(canonical, { ...runtime, ...partial, id: canonical } as VaultConfig);
  }
  removeVault(id: string): void { const canonical = this.aliases.get(id) ?? id; this.vaults.delete(canonical); this.shared = this.shared.filter(v => v.id !== canonical); this.deps.localPaths.remove(canonical); }
  validateVaultPath(value: string): boolean { try { return fs.statSync(value).isDirectory() && fs.statSync(path.join(value, this.app.vault.configDir)).isDirectory(); } catch { return false; } }
  getCurrentVaultId(): string | null { const base = this.currentPath(); if (!base) return null; return this.getVaults().find(v => v.available !== false && normalizeVaultPath(v.path, this.deps.platform) === normalizeVaultPath(base, this.deps.platform))?.id ?? null; }

  private reconcile(input: SharedVaultConfig[]): void {
    const groups = new Map<string, SharedVaultConfig[]>();
    for (const item of input) { const key = item.name.toLowerCase(); groups.set(key, [...(groups.get(key) ?? []), item]); }
    for (const group of groups.values()) {
      const discovered = this.deps.discoveredVaults.filter(d => d.name.toLowerCase() === group[0].name.toLowerCase());
      const valid = group.map(v => v.path ? expandPortablePath(v.path, this.deps.env, this.deps.home) : null).filter((v): v is string => Boolean(v) && this.validateVaultPath(v!));
      const uniqueValid = new Set(valid.map(v => normalizeVaultPath(v, this.deps.platform)));
      const merge = group.length > 1 && (discovered.length === 1 || uniqueValid.size === 1);
      for (const members of merge ? [group] : group.map(v => [v])) {
        const localDiscovery = discovered.length === 1 ? discovered[0] : undefined;
        const id = members[0].id;
        const shared = members.reduce<SharedVaultConfig>((result, value) => ({ ...value, ...result, enabled: result.enabled || value.enabled, id }), { ...members[0], id });
        members.forEach(v => { if (v.id !== id) this.aliases.set(v.id, id); });
        const legacy = members.map(v => v.path ? expandPortablePath(v.path, this.deps.env, this.deps.home) : null).find((v): v is string => Boolean(v) && this.validateVaultPath(v!));
        const candidate = this.deps.localPaths.get(id) ?? localDiscovery?.path ?? legacy;
        const resolved = candidate ? expandPortablePath(candidate, this.deps.env, this.deps.home) : null;
        this.shared.push(shared);
        this.vaults.set(id, resolved && this.validateVaultPath(resolved) ? { ...shared, path: resolved, available: true } : { ...shared, path: '', available: false });
      }
    }
  }
  private addUnconfiguredDiscoveries(): void {
    const names = new Set(this.shared.map(v => v.name.toLowerCase()));
    for (const found of this.deps.discoveredVaults) { if (names.has(found.name.toLowerCase())) continue; const shared = { id: found.registryId, name: found.name, enabled: true }; this.shared.push(shared); this.vaults.set(shared.id, { ...shared, path: found.path, available: true }); names.add(found.name.toLowerCase()); }
  }
  private detectCurrentVault(): void { const current = this.currentPath(); if (current && !this.getCurrentVaultId()) this.addVaultPath(current); }
  private currentPath(): string | null { const adapter = this.app.vault.adapter as FileSystemAdapter & { getBasePath?: () => string }; return typeof adapter.getBasePath === 'function' ? adapter.getBasePath() : null; }
  private defaultDependencies(): VaultRegistryDependencies {
    const platform = os.platform(), home = os.homedir(), env = process.env, candidates = getObsidianConfigCandidates(platform, env, home);
    const discoveredVaults = discoverObsidianVaults(candidates, { platform, env, home, configDirName: this.app.vault.configDir, logError: console.error });
    const registry = discoveredVaults.find(v => this.currentPath() && normalizeVaultPath(v.path, platform) === normalizeVaultPath(this.currentPath()!, platform))?.registryPath ?? candidates.find(fs.existsSync) ?? candidates[0] ?? path.join(home, '.config', 'obsidian', 'obsidian.json');
    return { platform, home, env, discoveredVaults, localPaths: new LocalVaultPathStore(path.join(path.dirname(registry), 'multi-vault-navigator.json')), generateId: () => `vault-${Date.now()}` };
  }
}
