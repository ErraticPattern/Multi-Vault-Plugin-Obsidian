import { DEFAULT_CROSS_VAULT_LINK_FORMAT, type CrossVaultLinkFormat } from './cross-vault-syntax';
import type { SharedVirtualLinkSettings } from './shared-settings/shared-settings-types';

export interface VaultConfig {
  id: string;
  name: string;
  path: string;
  enabled: boolean;
  color?: string;
  icon?: string;
  includePatterns?: string[];
  excludePatterns?: string[];
}

export interface IndexedFile {
  id: string;
  vaultId: string;
  vaultName: string;
  absolutePath: string;
  relativePath: string;
  basename: string;
  extension: string;
  frontmatter?: Record<string, unknown>;
  headings?: string[];
  tags?: string[];
  mtime: number;
  size: number;
  contentPreview?: string;
}

export interface IndexOptions {
  maxPreviewChars: number;
  autoRefreshOnStartup: boolean;
  globalExcludePatterns: string[];
  storeSnippetsInCache: boolean;
}

export interface SharedSettingsMetadata {
  lastAppliedRevision?: number;
  lastAppliedAt?: string;
  localParticipationOverride?: boolean;
}

export interface MultiVaultSettings {
  vaults: VaultConfig[];
  indexOptions: IndexOptions;
  savedSearches: { id: string, name: string, query: string }[];
  pinnedFiles: string[];
  uiStyle?: 'classic' | 'modern';
  sharedSettingsEnabled?: boolean;
  excludedVaultIds?: string[];
  showCrossVaultBadge: boolean;
  useVaultColorForLinks: boolean;
  /** Which spelling new cross-vault links are written in. Both are always readable. */
  crossVaultLinkFormat?: CrossVaultLinkFormat;
  virtualLinks?: SharedVirtualLinkSettings;
  sharedSettings?: SharedSettingsMetadata;
}

export interface IndexCache {
  version: number;
  generatedAt: string;
  files: IndexedFile[];
}

export const DEFAULT_SETTINGS: MultiVaultSettings = {
  vaults: [],
  indexOptions: {
    maxPreviewChars: 1000,
    autoRefreshOnStartup: true,
    globalExcludePatterns: [],
    storeSnippetsInCache: true
  },
  savedSearches: [],
  pinnedFiles: [],
  uiStyle: 'classic',
  sharedSettingsEnabled: false,
  excludedVaultIds: [],
  showCrossVaultBadge: true,
  useVaultColorForLinks: false,
  crossVaultLinkFormat: DEFAULT_CROSS_VAULT_LINK_FORMAT,
  virtualLinks: {
    enabled: false,
    excludedSourceVaultIds: [],
    targetVaultIdsBySource: {},
    colorMode: 'soft-pill',
    colorIntensity: 55
  },
  sharedSettings: {}
};
