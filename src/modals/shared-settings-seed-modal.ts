import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { App, Modal, Notice, Setting } from 'obsidian';

import { normalizeExistingPathKey } from '../shared-settings/path-identity';
import { projectSharedSettings } from '../shared-settings/shared-settings-projection';
import type { SharedSettingsStore } from '../shared-settings/shared-settings-store';
import type { SharedSettingsProjection } from '../shared-settings/shared-settings-types';
import { DEFAULT_SETTINGS, type MultiVaultSettings, type VaultConfig } from '../types';

const PLUGIN_DIRECTORY_NAME = 'multi-vault-navigator';

export const IDEAS_APPROVED_PALETTE: Readonly<Record<string, string>> = Object.freeze({
  Ideas: '#fa0000',
  Hobbies: '#1fe1e5',
  Mathematics: '#d4c30c',
  Medicine: '#ac20df',
});

export const SHARED_SETTING_FIELD_LABELS: readonly string[] = Object.freeze([
  'Global synchronization state',
  'Per-vault synchronization exclusions',
  'Vault stable ID',
  'Vault normalized path',
  'Vault display name',
  'Vault color',
  'Vault icon',
  'Vault enabled state',
  'Vault include patterns',
  'Vault exclude patterns',
  'Cross-vault badge visibility',
  'Cross-vault link color',
  'Virtual Linker integration enablement',
  'Virtual Linker per-source target vaults',
  'Virtual-link color mode',
  'Virtual-link color intensity',
]);

export interface SharedSeedPreviewVault {
  id: string;
  name: string;
  path: string;
  pathKey: string;
  color: string | null;
  icon: string | null;
  enabled: boolean;
  includePatterns: readonly string[];
  excludePatterns: readonly string[];
}

export interface SharedSeedPreviewModel {
  sourcePath: string;
  vaults: readonly SharedSeedPreviewVault[];
  synchronizedFields: readonly string[];
}

export interface LoadedIdeasSeed {
  seed: SharedSettingsProjection;
  dataPath: string;
  ideasVault: VaultConfig;
}

export interface LoadIdeasSeedOptions {
  readTextFile?: (filePath: string) => Promise<string>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizedIdeasName(value: string): string {
  return value.trim().normalize('NFKC').toLocaleLowerCase('en-US');
}

function isIdeasVaultByPath(vault: VaultConfig): boolean {
  return normalizedIdeasName(path.basename(path.resolve(vault.path))) === 'ideas';
}

function isIdeasVaultByName(vault: VaultConfig): boolean {
  return normalizedIdeasName(vault.name) === 'ideas';
}

function findIdeasVault(vaults: readonly VaultConfig[]): VaultConfig {
  const matching = vaults.filter((vault) => isIdeasVaultByPath(vault) || isIdeasVaultByName(vault));
  const uniqueByPath = new Map<string, VaultConfig>();
  for (const vault of matching) {
    const pathKey = normalizeExistingPathKey(vault.path, process.platform);
    const existing = uniqueByPath.get(pathKey);
    if (!existing || (isIdeasVaultByPath(vault) && !isIdeasVaultByPath(existing))) {
      uniqueByPath.set(pathKey, vault);
    }
  }

  if (uniqueByPath.size === 0) {
    throw new Error('The Ideas vault is not configured. Shared configuration remains off.');
  }
  if (uniqueByPath.size > 1) {
    throw new Error('More than one configured vault is named Ideas. Shared configuration remains off.');
  }
  return [...uniqueByPath.values()][0];
}

function parseVault(value: unknown, index: number): VaultConfig {
  if (!isRecord(value)) throw new Error(`Ideas data.json vaults[${index}] must be an object.`);
  if (typeof value.id !== 'string' || value.id.trim().length === 0) {
    throw new Error(`Ideas data.json vaults[${index}].id must be a non-empty string.`);
  }
  if (typeof value.name !== 'string' || value.name.trim().length === 0) {
    throw new Error(`Ideas data.json vaults[${index}].name must be a non-empty string.`);
  }
  if (typeof value.path !== 'string' || value.path.trim().length === 0) {
    throw new Error(`Ideas data.json vaults[${index}].path must be a non-empty string.`);
  }
  if (typeof value.enabled !== 'boolean') {
    throw new Error(`Ideas data.json vaults[${index}].enabled must be a boolean.`);
  }

  const optionalString = (field: 'color' | 'icon'): string | undefined => {
    const candidate = value[field];
    if (candidate === undefined) return undefined;
    if (typeof candidate !== 'string') {
      throw new Error(`Ideas data.json vaults[${index}].${field} must be a string.`);
    }
    return candidate;
  };
  const optionalStrings = (field: 'includePatterns' | 'excludePatterns'): string[] | undefined => {
    const candidate = value[field];
    if (candidate === undefined) return undefined;
    if (!Array.isArray(candidate) || candidate.some((entry) => typeof entry !== 'string')) {
      throw new Error(`Ideas data.json vaults[${index}].${field} must be an array of strings.`);
    }
    return [...candidate] as string[];
  };

  return {
    id: value.id,
    name: value.name,
    path: value.path,
    enabled: value.enabled,
    color: optionalString('color'),
    icon: optionalString('icon'),
    includePatterns: optionalStrings('includePatterns'),
    excludePatterns: optionalStrings('excludePatterns'),
  };
}

function validateProjectedSeed(seed: SharedSettingsProjection): void {
  const vaultIds = seed.vaults.map((vault) => vault.id);
  if (new Set(vaultIds).size !== vaultIds.length) {
    throw new Error('Ideas data.json produces duplicate canonical vault IDs. Shared configuration remains off.');
  }
  const knownIds = new Set(vaultIds);
  if (seed.excludedVaultIds.some((vaultId) => !knownIds.has(vaultId))) {
    throw new Error('Ideas data.json contains an unknown shared exclusion. Shared configuration remains off.');
  }
  if (seed.virtualLinks.excludedSourceVaultIds.some((vaultId) => !knownIds.has(vaultId))) {
    throw new Error('Ideas data.json contains an unknown Virtual Linker source. Shared configuration remains off.');
  }
  for (const [sourceId, targetIds] of Object.entries(seed.virtualLinks.targetVaultIdsBySource)) {
    if (!knownIds.has(sourceId) || targetIds.some((targetId) => !knownIds.has(targetId))) {
      throw new Error('Ideas data.json contains an unknown Virtual Linker target. Shared configuration remains off.');
    }
  }
}

function settingsFromIdeasData(value: unknown): MultiVaultSettings {
  if (!isRecord(value)) throw new Error('Ideas data.json must contain a settings object.');
  if (!Array.isArray(value.vaults)) throw new Error('Ideas data.json must contain a vaults array.');

  const rawVirtualLinks = isRecord(value.virtualLinks) ? value.virtualLinks : {};
  return {
    ...DEFAULT_SETTINGS,
    ...value,
    vaults: value.vaults.map(parseVault),
    indexOptions: { ...DEFAULT_SETTINGS.indexOptions },
    savedSearches: [],
    pinnedFiles: [],
    sharedSettingsEnabled: false,
    excludedVaultIds: Array.isArray(value.excludedVaultIds)
      ? value.excludedVaultIds.filter((entry): entry is string => typeof entry === 'string')
      : [],
    showCrossVaultBadge: value.showCrossVaultBadge !== false,
    useVaultColorForLinks: value.useVaultColorForLinks === true,
    virtualLinks: {
      ...DEFAULT_SETTINGS.virtualLinks!,
      ...rawVirtualLinks,
      colorIntensity: typeof rawVirtualLinks.colorIntensity === 'number'
        ? rawVirtualLinks.colorIntensity
        : 55,
    },
    sharedSettings: {},
  } as MultiVaultSettings;
}

export async function loadIdeasSeed(
  vaults: readonly VaultConfig[],
  configDirectoryName = '.obsidian',
  options: LoadIdeasSeedOptions = {},
): Promise<LoadedIdeasSeed> {
  const ideasVault = findIdeasVault(vaults);
  const dataPath = path.join(
    ideasVault.path,
    configDirectoryName,
    'plugins',
    PLUGIN_DIRECTORY_NAME,
    'data.json',
  );
  const readTextFile = options.readTextFile ?? ((filePath: string) => readFile(filePath, 'utf8'));

  let parsed: unknown;
  try {
    parsed = JSON.parse(await readTextFile(dataPath)) as unknown;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not read a valid Ideas Multi-Vault data.json at ${dataPath}: ${reason}`);
  }

  const local = settingsFromIdeasData(parsed);
  const seed = {
    ...projectSharedSettings(local, ideasVault.path),
    enabled: true,
  };
  validateProjectedSeed(seed);
  if (!seed.vaults.some((vault) => vault.id === ideasVault.id)) {
    throw new Error('Ideas data.json does not contain the canonical Ideas vault. Shared configuration remains off.');
  }

  return { seed, dataPath, ideasVault: { ...ideasVault } };
}

export function makeSharedSeedPreview(
  seed: SharedSettingsProjection,
  sourcePath: string,
): SharedSeedPreviewModel {
  return {
    sourcePath,
    vaults: seed.vaults.map((vault) => ({
      id: vault.id,
      name: vault.name,
      path: vault.path ?? 'Resolved per device',
      pathKey: vault.pathKey ?? vault.id,
      color: vault.color ?? null,
      icon: vault.icon ?? null,
      enabled: vault.enabled,
      includePatterns: [...(vault.includePatterns ?? [])],
      excludePatterns: [...(vault.excludePatterns ?? [])],
    })),
    synchronizedFields: [...SHARED_SETTING_FIELD_LABELS],
  };
}

export class SharedSettingsSeedModal extends Modal {
  private readonly preview: SharedSeedPreviewModel;
  private confirming = false;

  constructor(
    app: App,
    private readonly store: SharedSettingsStore,
    private readonly writerInstanceId: string,
    private readonly seed: SharedSettingsProjection,
    sourcePath: string,
    private readonly onInitialized?: () => Promise<void> | void,
  ) {
    super(app);
    this.preview = makeSharedSeedPreview(seed, sourcePath);
  }

  onOpen(): void {
    this.contentEl.empty();
    this.contentEl.createEl('h2', { text: 'Enable shared configuration' });
    this.contentEl.createEl('p', {
      text: 'Review the read-only configuration from Ideas. Nothing is written until you confirm.',
    });
    new Setting(this.contentEl).setName('Source').setDesc(this.preview.sourcePath);

    for (const vault of this.preview.vaults) {
      const details = [vault.path, `ID: ${vault.id}`, `Color: ${vault.color ?? 'Theme default'}`];
      if (!vault.enabled) details.push('Disabled');
      new Setting(this.contentEl).setName(vault.name).setDesc(details.join(' · '));
    }

    new Setting(this.contentEl)
      .setName('Synchronized fields')
      .setDesc(this.preview.synchronizedFields.join(', '));
    new Setting(this.contentEl)
      .setName('Confirmation')
      .setDesc('This creates the shared immutable settings journal and enables synchronization.')
      .addButton((button) => button.setButtonText('Cancel').onClick(() => this.close()))
      .addButton((button) => button
        .setButtonText('Enable synchronization')
        .setCta()
        .onClick(async () => {
          if (this.confirming) return;
          this.confirming = true;
          button.setDisabled(true);
          try {
            await this.store.initialize(this.seed, this.writerInstanceId);
            await this.onInitialized?.();
            this.close();
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            new Notice(`Shared configuration could not be initialized: ${message}`);
            button.setDisabled(false);
          } finally {
            this.confirming = false;
          }
        }));
  }
}
