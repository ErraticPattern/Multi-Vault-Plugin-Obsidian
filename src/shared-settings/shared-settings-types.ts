export const SHARED_SETTINGS_SCHEMA_VERSION = 2 as const;

export interface SharedVaultRecord {
  id: string;
  /** Legacy schema-1 path fields, accepted only while migrating old journals. */
  pathKey?: string;
  path?: string;
  name: string;
  color?: string;
  icon?: string;
  enabled: boolean;
  includePatterns?: string[];
  excludePatterns?: string[];
}

export type VirtualLinkColorMode = 'off' | 'muted-text' | 'colored-underline' | 'soft-pill';

export interface SharedVirtualLinkSettings {
  enabled: boolean;
  excludedSourceVaultIds: string[];
  targetVaultIdsBySource: Record<string, string[]>;
  colorMode: VirtualLinkColorMode;
  colorIntensity: number;
}

export interface SharedSettingsProjection {
  enabled: boolean;
  excludedVaultIds: string[];
  vaults: SharedVaultRecord[];
  crossVaultLinks: {
    showVaultBadge: boolean;
    useVaultColorForLinks: boolean;
  };
  virtualLinks: SharedVirtualLinkSettings;
}

export interface SharedSettingsManifest extends SharedSettingsProjection {
  schemaVersion: 2;
  revision: number;
  updatedAt: string;
  writerInstanceId: string;
  extensions?: Record<string, unknown>;
}
