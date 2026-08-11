import type { MultiVaultSettings, VaultConfig } from '../types';
import {
  inferPlatformFromPath,
  normalizePathDisplay,
  normalizePathKey,
} from './path-identity';
import type {
  SharedSettingsProjection,
  SharedVaultRecord,
  SharedVirtualLinkSettings,
  VirtualLinkColorMode,
} from './shared-settings-types';

const HEX_COLOR_PATTERN = /^#[0-9a-f]{6}$/i;
const VALID_VIRTUAL_LINK_COLOR_MODES: readonly VirtualLinkColorMode[] = [
  'off',
  'muted-text',
  'colored-underline',
  'soft-pill',
];
const DEFAULT_VIRTUAL_LINKS: SharedVirtualLinkSettings = {
  enabled: false,
  excludedSourceVaultIds: [],
  targetVaultIdsBySource: {},
  colorMode: 'soft-pill',
  colorIntensity: 50,
};

interface CanonicalVaultCandidate {
  canonical: SharedVaultRecord;
  aliases: string[];
}

function cloneSavedSearches(savedSearches: MultiVaultSettings['savedSearches']): MultiVaultSettings['savedSearches'] {
  return savedSearches.map((savedSearch) => ({ ...savedSearch }));
}

function cloneIndexOptions(indexOptions: MultiVaultSettings['indexOptions']): MultiVaultSettings['indexOptions'] {
  return {
    ...indexOptions,
    globalExcludePatterns: [...(indexOptions.globalExcludePatterns || [])],
  };
}

function cloneSharedSettingsMetadata(sharedSettings: MultiVaultSettings['sharedSettings']): MultiVaultSettings['sharedSettings'] {
  return sharedSettings ? { ...sharedSettings } : sharedSettings;
}

function sanitizeColor(color?: string): string | undefined {
  return color && HEX_COLOR_PATTERN.test(color) ? color : undefined;
}

function dedupeStrings(values: readonly string[] | undefined): string[] {
  if (!values) return [];

  const deduped: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    if (typeof value !== 'string' || seen.has(value)) continue;
    seen.add(value);
    deduped.push(value);
  }

  return deduped;
}

function sanitizeStringArray(values: readonly string[] | undefined): string[] | undefined {
  const deduped = dedupeStrings(values);
  return deduped.length > 0 ? deduped : undefined;
}

function sanitizeColorMode(mode: SharedVirtualLinkSettings['colorMode'] | undefined): VirtualLinkColorMode {
  return VALID_VIRTUAL_LINK_COLOR_MODES.includes(mode ?? 'soft-pill')
    ? (mode ?? 'soft-pill')
    : 'soft-pill';
}

function sanitizeColorIntensity(intensity: number | undefined): number {
  const numeric = Number.isFinite(intensity) ? Math.round(intensity as number) : DEFAULT_VIRTUAL_LINKS.colorIntensity;
  return Math.min(90, Math.max(10, numeric));
}

function compareVaultCandidates(left: SharedVaultRecord, right: SharedVaultRecord): number {
  return left.id.localeCompare(right.id)
    || left.name.localeCompare(right.name)
    || left.path.localeCompare(right.path);
}

function resolveVaultPlatform(vaultPath: string, currentPathKey: string): NodeJS.Platform {
  return inferPlatformFromPath(vaultPath, inferPlatformFromPath(currentPathKey));
}

function toSharedVaultRecord(vault: VaultConfig, currentPathKey: string): SharedVaultRecord {
  const platform = resolveVaultPlatform(vault.path, currentPathKey);

  return {
    id: vault.id,
    pathKey: normalizePathKey(vault.path, platform),
    path: normalizePathDisplay(vault.path, platform),
    name: vault.name,
    color: sanitizeColor(vault.color),
    icon: vault.icon,
    enabled: vault.enabled,
    includePatterns: sanitizeStringArray(vault.includePatterns),
    excludePatterns: sanitizeStringArray(vault.excludePatterns),
  };
}

function buildCanonicalVaults(local: MultiVaultSettings, currentPathKey: string): {
  vaults: SharedVaultRecord[];
  canonicalIdByAliasId: Map<string, string>;
} {
  const grouped = new Map<string, SharedVaultRecord[]>();

  for (const vault of local.vaults) {
    const candidate = toSharedVaultRecord(vault, currentPathKey);
    const bucket = grouped.get(candidate.pathKey);
    if (bucket) {
      bucket.push(candidate);
      continue;
    }
    grouped.set(candidate.pathKey, [candidate]);
  }

  const canonicalEntries: CanonicalVaultCandidate[] = [...grouped.values()].map((candidates) => {
    const sorted = [...candidates].sort(compareVaultCandidates);
    return {
      canonical: sorted[0],
      aliases: candidates.map((candidate) => candidate.id),
    };
  });

  canonicalEntries.sort((left, right) => left.canonical.pathKey.localeCompare(right.canonical.pathKey));

  const canonicalIdByAliasId = new Map<string, string>();
  for (const entry of canonicalEntries) {
    for (const aliasId of entry.aliases) {
      canonicalIdByAliasId.set(aliasId, entry.canonical.id);
    }
  }

  return {
    vaults: canonicalEntries.map((entry) => ({
      ...entry.canonical,
      includePatterns: entry.canonical.includePatterns ? [...entry.canonical.includePatterns] : undefined,
      excludePatterns: entry.canonical.excludePatterns ? [...entry.canonical.excludePatterns] : undefined,
    })),
    canonicalIdByAliasId,
  };
}

function canonicalizeIdList(
  ids: readonly string[] | undefined,
  canonicalIdByAliasId: ReadonlyMap<string, string>,
  knownIds: ReadonlySet<string>,
): string[] {
  const deduped: string[] = [];
  const seen = new Set<string>();

  for (const id of ids ?? []) {
    const canonicalId = canonicalIdByAliasId.get(id) ?? id;
    if (!knownIds.has(canonicalId) || seen.has(canonicalId)) continue;
    seen.add(canonicalId);
    deduped.push(canonicalId);
  }

  return deduped;
}

function sanitizeVirtualLinks(
  virtualLinks: SharedVirtualLinkSettings | undefined,
  canonicalIdByAliasId: ReadonlyMap<string, string>,
  knownIds: ReadonlySet<string>,
): SharedVirtualLinkSettings {
  const base = virtualLinks ?? DEFAULT_VIRTUAL_LINKS;
  const targetVaultIdsBySource = new Map<string, string[]>();

  for (const [sourceId, targetIds] of Object.entries(base.targetVaultIdsBySource || {})) {
    const canonicalSourceId = canonicalIdByAliasId.get(sourceId) ?? sourceId;
    if (!knownIds.has(canonicalSourceId)) continue;

    const mergedTargets = targetVaultIdsBySource.get(canonicalSourceId) ?? [];
    mergedTargets.push(...canonicalizeIdList(targetIds, canonicalIdByAliasId, knownIds));
    targetVaultIdsBySource.set(canonicalSourceId, mergedTargets);
  }

  const sanitizedTargets = Object.fromEntries(
    [...targetVaultIdsBySource.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([sourceId, targetIds]) => [
        sourceId,
        canonicalizeIdList(targetIds, new Map<string, string>(), knownIds),
      ]),
  );

  return {
    enabled: base.enabled === true,
    excludedSourceVaultIds: canonicalizeIdList(base.excludedSourceVaultIds, canonicalIdByAliasId, knownIds),
    targetVaultIdsBySource: sanitizedTargets,
    colorMode: sanitizeColorMode(base.colorMode),
    colorIntensity: sanitizeColorIntensity(base.colorIntensity),
  };
}

function toVaultConfig(record: SharedVaultRecord): VaultConfig {
  return {
    id: record.id,
    name: record.name,
    path: record.path,
    color: sanitizeColor(record.color),
    icon: record.icon,
    enabled: record.enabled,
    includePatterns: record.includePatterns ? [...record.includePatterns] : undefined,
    excludePatterns: record.excludePatterns ? [...record.excludePatterns] : undefined,
  };
}

function sanitizeProjectionVaults(projection: SharedSettingsProjection): SharedVaultRecord[] {
  const grouped = new Map<string, SharedVaultRecord[]>();

  for (const vault of projection.vaults) {
    const platform = inferPlatformFromPath(vault.pathKey || vault.path);
    const pathKey = normalizePathKey(vault.pathKey || vault.path, platform);
    const candidate: SharedVaultRecord = {
      id: vault.id,
      pathKey,
      path: normalizePathDisplay(vault.path || vault.pathKey, platform),
      name: vault.name,
      color: sanitizeColor(vault.color),
      icon: vault.icon,
      enabled: vault.enabled === true,
      includePatterns: sanitizeStringArray(vault.includePatterns),
      excludePatterns: sanitizeStringArray(vault.excludePatterns),
    };

    const bucket = grouped.get(pathKey);
    if (bucket) {
      bucket.push(candidate);
      continue;
    }
    grouped.set(pathKey, [candidate]);
  }

  return [...grouped.values()]
    .map((candidates) => [...candidates].sort(compareVaultCandidates)[0])
    .sort((left, right) => left.pathKey.localeCompare(right.pathKey))
    .map((vault) => ({
      ...vault,
      includePatterns: vault.includePatterns ? [...vault.includePatterns] : undefined,
      excludePatterns: vault.excludePatterns ? [...vault.excludePatterns] : undefined,
    }));
}

export function projectSharedSettings(local: MultiVaultSettings, currentPathKey: string): SharedSettingsProjection {
  const { vaults, canonicalIdByAliasId } = buildCanonicalVaults(local, currentPathKey);
  const knownIds = new Set(vaults.map((vault) => vault.id));

  return {
    enabled: local.sharedSettingsEnabled === true,
    excludedVaultIds: canonicalizeIdList(local.excludedVaultIds, canonicalIdByAliasId, knownIds),
    vaults,
    crossVaultLinks: {
      showVaultBadge: local.showCrossVaultBadge !== false,
      useVaultColorForLinks: local.useVaultColorForLinks === true,
    },
    virtualLinks: sanitizeVirtualLinks(local.virtualLinks, canonicalIdByAliasId, knownIds),
  };
}

export function applySharedProjection(local: MultiVaultSettings, projection: SharedSettingsProjection): MultiVaultSettings {
  const sanitizedVaults = sanitizeProjectionVaults(projection);
  const knownIds = new Set(sanitizedVaults.map((vault) => vault.id));
  const canonicalIdByAliasId = new Map(sanitizedVaults.map((vault) => [vault.id, vault.id]));
  const existingVaultsByPathKey = new Map<string, VaultConfig>();

  for (const vault of local.vaults) {
    const platform = inferPlatformFromPath(vault.path);
    existingVaultsByPathKey.set(normalizePathKey(vault.path, platform), vault);
  }

  return {
    ...local,
    vaults: sanitizedVaults.map((vault) => {
      const existing = existingVaultsByPathKey.get(vault.pathKey);
      return toVaultConfig({
        ...vault,
        path: vault.path || (existing ? existing.path : vault.pathKey),
        name: vault.name || existing?.name || vault.id,
      });
    }),
    indexOptions: cloneIndexOptions(local.indexOptions),
    savedSearches: cloneSavedSearches(local.savedSearches),
    pinnedFiles: [...local.pinnedFiles],
    sharedSettingsEnabled: projection.enabled === true,
    excludedVaultIds: canonicalizeIdList(projection.excludedVaultIds, canonicalIdByAliasId, knownIds),
    showCrossVaultBadge: projection.crossVaultLinks.showVaultBadge !== false,
    useVaultColorForLinks: projection.crossVaultLinks.useVaultColorForLinks === true,
    virtualLinks: sanitizeVirtualLinks(projection.virtualLinks, canonicalIdByAliasId, knownIds),
    sharedSettings: cloneSharedSettingsMetadata(local.sharedSettings),
  };
}
