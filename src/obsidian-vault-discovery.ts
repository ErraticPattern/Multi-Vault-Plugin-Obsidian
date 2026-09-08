import * as fs from 'fs';
import * as path from 'path';
import { expandPortablePath, getObsidianConfigCandidates, normalizeVaultPath, PathEnvironment } from './vault-paths';

export interface DiscoveredVault { registryId: string; name: string; path: string; registryPath: string }
export interface DiscoveryDependencies {
  platform: string; env: PathEnvironment; home: string; configDirName: string;
  existsSync?: typeof fs.existsSync; readFileSync?: typeof fs.readFileSync;
  logError(message: string, error: unknown): void;
}

export function discoverObsidianVaults(candidates: string[], deps: DiscoveryDependencies): DiscoveredVault[] {
  const exists = deps.existsSync ?? fs.existsSync;
  const read = deps.readFileSync ?? fs.readFileSync;
  const result: DiscoveredVault[] = [];
  const seen = new Set<string>();
  for (const registryPath of candidates) {
    if (!exists(registryPath)) continue;
    try {
      const json = JSON.parse(read(registryPath, 'utf8')) as { vaults?: Record<string, { path?: string }> };
      for (const [registryId, info] of Object.entries(json.vaults ?? {})) {
        if (!info.path) continue;
        const vaultPath = expandPortablePath(info.path, deps.env, deps.home);
        if (!exists(path.join(vaultPath, deps.configDirName))) continue;
        const key = normalizeVaultPath(vaultPath, deps.platform);
        if (seen.has(key)) continue;
        seen.add(key);
        result.push({ registryId, name: path.basename(vaultPath), path: vaultPath, registryPath });
      }
    } catch (error) {
      deps.logError(`Failed to read Obsidian registry: ${registryPath}`, error);
    }
  }
  return result;
}

export function chooseLocalConfigDirectory(
  candidates: string[], currentVaultPath: string | null, discovered: DiscoveredVault[],
  platform: string, env: PathEnvironment, home: string,
): string {
  if (currentVaultPath) {
    const current = normalizeVaultPath(currentVaultPath, platform);
    const match = discovered.find(v => normalizeVaultPath(v.path, platform) === current);
    if (match) return path.dirname(match.registryPath);
  }
  const existing = candidates.find(candidate => discovered.some(v => v.registryPath === candidate));
  if (existing) return path.dirname(existing);
  const fallback = getObsidianConfigCandidates(platform, env, home)[0];
  return fallback ? path.dirname(fallback) : home;
}
