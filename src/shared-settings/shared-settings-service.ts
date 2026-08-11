import os from 'node:os';
import path from 'node:path';
import { stat } from 'node:fs/promises';

import type { MultiVaultSettings, VaultConfig } from '../types';
import { normalizeExistingPathKey } from './path-identity';
import { applySharedProjection } from './shared-settings-projection';
import {
  SharedSettingsStore,
  type SharedSettingsPatch,
} from './shared-settings-store';
import type {
  SharedSettingsManifest,
  SharedSettingsProjection,
  SharedVaultRecord,
} from './shared-settings-types';

const DEFAULT_POLL_INTERVAL_MS = 5_000;
const DISPOSED_MESSAGE = 'Shared settings service is disposed.';

type TimerHandle = ReturnType<typeof globalThis.setInterval>;

export type SyncApplyResult =
  | { kind: 'unchanged'; revision: number | null }
  | { kind: 'disabled'; revision: number | null }
  | { kind: 'excluded'; revision: number }
  | { kind: 'applied'; revision: number; appearanceChanged: boolean; catalogChanged: boolean }
  | { kind: 'error'; message: string; revision: number | null };

export interface SharedSettingsRuntime {
  replaceVaults?: (vaults: VaultConfig[]) => void;
  saveLocalMirror?: (settings: MultiVaultSettings) => Promise<void> | void;
  onAppearanceChanged?: () => Promise<void> | void;
  onCatalogChanged?: () => Promise<void> | void;
}

export interface SharedSettingsServiceOptions {
  store: SharedSettingsStore;
  settings: MultiVaultSettings;
  currentVaultPath: string;
  writerInstanceId: string;
  pollIntervalMs?: number;
  polling?: boolean;
  setInterval?: (callback: () => void, milliseconds: number) => TimerHandle;
  clearInterval?: (handle: TimerHandle) => void;
  registerInterval?: (handle: TimerHandle) => void;
  now?: () => Date;
}

export interface SharedSettingsStatus {
  enabled: boolean;
  excluded: boolean;
  revision: number | null;
  lastAppliedRevision: number | null;
  lastAppliedAt: string | null;
  path: string;
  error: string | null;
  disposed: boolean;
}

interface JournalStatState {
  seed: string | null;
  patches: string | null;
}

interface SharedChangeSnapshot {
  appearance: unknown;
  catalog: unknown;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function cloneVault(vault: VaultConfig): VaultConfig {
  return {
    ...vault,
    includePatterns: vault.includePatterns ? [...vault.includePatterns] : undefined,
    excludePatterns: vault.excludePatterns ? [...vault.excludePatterns] : undefined,
  };
}

function manifestProjection(manifest: SharedSettingsManifest): SharedSettingsProjection {
  return {
    enabled: manifest.enabled,
    excludedVaultIds: [...manifest.excludedVaultIds],
    vaults: manifest.vaults.map((vault) => ({
      ...vault,
      includePatterns: vault.includePatterns ? [...vault.includePatterns] : undefined,
      excludePatterns: vault.excludePatterns ? [...vault.excludePatterns] : undefined,
    })),
    crossVaultLinks: { ...manifest.crossVaultLinks },
    virtualLinks: {
      ...manifest.virtualLinks,
      excludedSourceVaultIds: [...manifest.virtualLinks.excludedSourceVaultIds],
      targetVaultIdsBySource: Object.fromEntries(
        Object.entries(manifest.virtualLinks.targetVaultIdsBySource)
          .map(([sourceId, targetIds]) => [sourceId, [...targetIds]]),
      ),
    },
  };
}

function vaultCatalogRecord(vault: VaultConfig): unknown {
  return {
    id: vault.id,
    name: vault.name,
    path: vault.path,
    enabled: vault.enabled,
    includePatterns: vault.includePatterns ?? [],
    excludePatterns: vault.excludePatterns ?? [],
  };
}

function snapshotSharedChanges(settings: MultiVaultSettings): SharedChangeSnapshot {
  return {
    appearance: {
      vaults: settings.vaults.map((vault) => ({
        id: vault.id,
        color: vault.color,
        icon: vault.icon,
      })),
      crossVaultLinks: {
        showVaultBadge: settings.showCrossVaultBadge,
        useVaultColorForLinks: settings.useVaultColorForLinks,
      },
      virtualLinkStyle: {
        mode: settings.virtualLinks?.colorMode,
        intensity: settings.virtualLinks?.colorIntensity,
      },
    },
    catalog: {
      vaults: settings.vaults.map(vaultCatalogRecord),
      virtualLinks: {
        enabled: settings.virtualLinks?.enabled,
        excludedSourceVaultIds: settings.virtualLinks?.excludedSourceVaultIds ?? [],
        targetVaultIdsBySource: settings.virtualLinks?.targetVaultIdsBySource ?? {},
      },
    },
  };
}

function equalSnapshot(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function statIdentity(stats: Awaited<ReturnType<typeof stat>>): string {
  return `${stats.mtimeMs}:${stats.ctimeMs}:${stats.size}`;
}

async function optionalStatIdentity(targetPath: string): Promise<string | null> {
  try {
    return statIdentity(await stat(targetPath));
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error
      && (error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

function sameJournalState(left: JournalStatState | null, right: JournalStatState): boolean {
  return left !== null && left.seed === right.seed && left.patches === right.patches;
}

export function resolveSharedSettingsApplicationDataRoot(
  platform: NodeJS.Platform = process.platform,
  environment: NodeJS.ProcessEnv = process.env,
  homeDirectory: string = os.homedir(),
): string {
  let obsidianDataRoot: string;
  if (platform === 'win32') {
    obsidianDataRoot = path.join(environment.APPDATA ?? path.join(homeDirectory, 'AppData', 'Roaming'), 'Obsidian');
  } else if (platform === 'darwin') {
    obsidianDataRoot = path.join(homeDirectory, 'Library', 'Application Support', 'obsidian');
  } else {
    obsidianDataRoot = path.join(environment.XDG_CONFIG_HOME ?? path.join(homeDirectory, '.config'), 'obsidian');
  }
  return path.join(obsidianDataRoot, 'multi-vault-navigator');
}

export class SharedSettingsService {
  private readonly store: SharedSettingsStore;
  private readonly settings: MultiVaultSettings;
  private readonly currentVaultPathKey: string;
  private readonly writerInstanceId: string;
  private readonly pollIntervalMs: number;
  private readonly polling: boolean;
  private readonly createInterval: (callback: () => void, milliseconds: number) => TimerHandle;
  private readonly cancelInterval: (handle: TimerHandle) => void;
  private readonly registerInterval?: (handle: TimerHandle) => void;
  private readonly now: () => Date;

  private lastValidManifest: SharedSettingsManifest | null = null;
  private lastAppliedRevision: number | null;
  private lastError: string | null = null;
  private disposed = false;
  private runtime: SharedSettingsRuntime | null = null;
  private pollTimer: TimerHandle | null = null;
  private journalState: JournalStatState | null = null;
  private operationTail: Promise<void> = Promise.resolve();
  private callbackFlush: Promise<void> | null = null;
  private pendingAppearanceChanged = false;
  private pendingCatalogChanged = false;

  constructor(options: SharedSettingsServiceOptions) {
    this.store = options.store;
    this.settings = options.settings;
    this.currentVaultPathKey = normalizeExistingPathKey(options.currentVaultPath, process.platform);
    this.writerInstanceId = options.writerInstanceId;
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.polling = options.polling !== false;
    this.createInterval = options.setInterval ?? ((callback, milliseconds) => (
      globalThis.setInterval(callback, milliseconds)
    ));
    this.cancelInterval = options.clearInterval ?? ((handle) => globalThis.clearInterval(handle));
    this.registerInterval = options.registerInterval;
    this.now = options.now ?? (() => new Date());
    this.lastAppliedRevision = settingsRevision(options.settings);
  }

  initialize(): Promise<SyncApplyResult> {
    return this.initializeAndApplyToSettings();
  }

  initializeAndApplyToSettings(): Promise<SyncApplyResult> {
    return this.enqueue(async () => {
      const result = await this.readAndApplyLatest(true);
      await this.captureJournalState();
      return result;
    });
  }

  attachRuntime(runtime: SharedSettingsRuntime): void {
    if (this.disposed) throw new Error(DISPOSED_MESSAGE);
    this.runtime = runtime;
    if (!this.polling || this.pollTimer !== null) return;

    const timer = this.createInterval(() => {
      void this.pollForChanges();
    }, this.pollIntervalMs);
    this.pollTimer = timer;
    this.registerInterval?.(timer);
  }

  applyLatest(force = false): Promise<SyncApplyResult> {
    return this.enqueue(async () => {
      const result = await this.readAndApplyLatest(force);
      await this.captureJournalState();
      return result;
    });
  }

  publish(patch: SharedSettingsPatch): Promise<SyncApplyResult> {
    return this.enqueue(async () => {
      if (this.disposed) return this.disposedResult();

      let current: SharedSettingsManifest | null;
      try {
        current = await this.store.read();
      } catch (error) {
        return this.recordError(error);
      }

      if (!current) {
        this.lastError = 'Shared settings have not been initialized.';
        return {
          kind: 'error',
          message: this.lastError,
          revision: this.lastValidManifest?.revision ?? null,
        };
      }

      this.lastValidManifest = current;
      if (!current.enabled) {
        this.lastError = null;
        return { kind: 'disabled', revision: current.revision };
      }
      if (this.isCurrentVaultExcluded(current)) {
        this.lastError = null;
        return { kind: 'excluded', revision: current.revision };
      }

      try {
        const published = await this.store.patch(patch, this.writerInstanceId);
        this.lastValidManifest = published;
        this.lastError = null;
        await this.captureJournalState();
        return await this.applyManifest(published);
      } catch (error) {
        return this.recordError(error);
      }
    });
  }

  getStatus(): SharedSettingsStatus {
    const manifest = this.lastValidManifest;
    return {
      enabled: manifest?.enabled ?? this.settings.sharedSettingsEnabled === true,
      excluded: manifest ? this.isCurrentVaultExcluded(manifest) : false,
      revision: manifest?.revision ?? null,
      lastAppliedRevision: this.lastAppliedRevision,
      lastAppliedAt: this.settings.sharedSettings?.lastAppliedAt ?? null,
      path: this.store.directory,
      error: this.lastError,
      disposed: this.disposed,
    };
  }

  hasAuthoritativeManifest(): boolean {
    const manifest = this.lastValidManifest;
    return manifest !== null && manifest.enabled && !this.isCurrentVaultExcluded(manifest);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.pollTimer !== null) {
      this.cancelInterval(this.pollTimer);
      this.pollTimer = null;
    }
    this.runtime = null;
    this.pendingAppearanceChanged = false;
    this.pendingCatalogChanged = false;
  }

  private enqueue(operation: () => Promise<SyncApplyResult>): Promise<SyncApplyResult> {
    const result = this.operationTail.then(operation, operation);
    this.operationTail = result.then(() => undefined, () => undefined);
    return result;
  }

  private async readAndApplyLatest(force = false): Promise<SyncApplyResult> {
    if (this.disposed) return this.disposedResult();

    try {
      const manifest = await this.store.read();
      if (!manifest) {
        this.lastError = null;
        return { kind: 'unchanged', revision: this.lastValidManifest?.revision ?? null };
      }
      this.lastValidManifest = manifest;
      this.lastError = null;
      return await this.applyManifest(manifest, force);
    } catch (error) {
      return this.recordError(error);
    }
  }

  private async applyManifest(manifest: SharedSettingsManifest, force = false): Promise<SyncApplyResult> {
    if (!manifest.enabled) return { kind: 'disabled', revision: manifest.revision };
    if (this.isCurrentVaultExcluded(manifest)) return { kind: 'excluded', revision: manifest.revision };
    if (!force && this.lastAppliedRevision !== null && manifest.revision <= this.lastAppliedRevision) {
      return { kind: 'unchanged', revision: manifest.revision };
    }

    const before = snapshotSharedChanges(this.settings);
    const applied = applySharedProjection(this.settings, manifestProjection(manifest));
    const after = snapshotSharedChanges(applied);
    const appearanceChanged = !equalSnapshot(before.appearance, after.appearance);
    const catalogChanged = !equalSnapshot(before.catalog, after.catalog);
    const appliedAt = this.now().toISOString();

    applied.sharedSettings = {
      ...applied.sharedSettings,
      lastAppliedRevision: manifest.revision,
      lastAppliedAt: appliedAt,
    };
    Object.assign(this.settings, applied);
    this.lastAppliedRevision = manifest.revision;

    const runtime = this.runtime;
    if (runtime) {
      runtime.replaceVaults?.(this.settings.vaults.map(cloneVault));
      if (runtime.saveLocalMirror) {
        try {
          await runtime.saveLocalMirror(this.settings);
        } catch (error) {
          this.lastError = `Shared settings were applied, but the local mirror could not be saved: ${errorMessage(error)}`;
        }
      }
      this.scheduleCallbacks(appearanceChanged, catalogChanged);
    }

    return {
      kind: 'applied',
      revision: manifest.revision,
      appearanceChanged,
      catalogChanged,
    };
  }

  private isCurrentVaultExcluded(manifest: SharedSettingsManifest): boolean {
    const currentVault = manifest.vaults.find((vault) => vault.pathKey === this.currentVaultPathKey)
      ?? manifest.vaults.find((vault) => this.vaultMatchesCurrentPath(vault));
    return currentVault !== undefined && manifest.excludedVaultIds.includes(currentVault.id);
  }

  private vaultMatchesCurrentPath(vault: SharedVaultRecord): boolean {
    return normalizeExistingPathKey(vault.path, process.platform) === this.currentVaultPathKey;
  }

  private recordError(error: unknown): SyncApplyResult {
    this.lastError = errorMessage(error);
    return {
      kind: 'error',
      message: this.lastError,
      revision: this.lastValidManifest?.revision ?? null,
    };
  }

  private disposedResult(): SyncApplyResult {
    this.lastError = DISPOSED_MESSAGE;
    return {
      kind: 'error',
      message: DISPOSED_MESSAGE,
      revision: this.lastValidManifest?.revision ?? null,
    };
  }

  private async readJournalState(): Promise<JournalStatState> {
    const [seed, patches] = await Promise.all([
      optionalStatIdentity(this.store.seedPath),
      optionalStatIdentity(this.store.patchesDirectory),
    ]);
    return { seed, patches };
  }

  private async captureJournalState(): Promise<void> {
    try {
      this.journalState = await this.readJournalState();
    } catch (error) {
      this.lastError = errorMessage(error);
    }
  }

  private async pollForChanges(): Promise<void> {
    if (this.disposed) return;
    try {
      const nextState = await this.readJournalState();
      if (sameJournalState(this.journalState, nextState)) return;
      this.journalState = nextState;
      await this.applyLatest();
    } catch (error) {
      this.recordError(error);
    }
  }

  private scheduleCallbacks(appearanceChanged: boolean, catalogChanged: boolean): void {
    this.pendingAppearanceChanged ||= appearanceChanged;
    this.pendingCatalogChanged ||= catalogChanged;
    if (this.callbackFlush || (!this.pendingAppearanceChanged && !this.pendingCatalogChanged)) return;

    this.callbackFlush = Promise.resolve().then(async () => {
      if (this.disposed) return;
      const runtime = this.runtime;
      const notifyAppearance = this.pendingAppearanceChanged;
      const notifyCatalog = this.pendingCatalogChanged;
      this.pendingAppearanceChanged = false;
      this.pendingCatalogChanged = false;
      if (!runtime) return;

      try {
        if (notifyAppearance) await runtime.onAppearanceChanged?.();
        if (notifyCatalog) await runtime.onCatalogChanged?.();
      } catch (error) {
        this.lastError = `Shared settings refresh callback failed: ${errorMessage(error)}`;
      }
    }).finally(() => {
      this.callbackFlush = null;
      if (!this.disposed && (this.pendingAppearanceChanged || this.pendingCatalogChanged)) {
        this.scheduleCallbacks(false, false);
      }
    });
  }
}

function settingsRevision(settings: MultiVaultSettings): number | null {
  const revision = settings.sharedSettings?.lastAppliedRevision;
  return revision !== undefined && Number.isSafeInteger(revision) && revision >= 0 ? revision : null;
}
