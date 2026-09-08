import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, realpath, rm, symlink } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

import { applySharedProjection, projectSharedSettings } from '../src/shared-settings/shared-settings-projection';
import {
  normalizePathDisplay,
  normalizePathKey,
  normalizeVaultPath,
} from '../src/shared-settings/path-identity';
import type { SharedSettingsProjection } from '../src/shared-settings/shared-settings-types';
import type { MultiVaultSettings } from '../src/types';

const tempDirs: string[] = [];
const SUPPORTED_DIRECTORY_ALIAS_PLATFORMS = new Set<NodeJS.Platform>([
  'aix',
  'darwin',
  'freebsd',
  'linux',
  'openbsd',
  'sunos',
  'win32',
]);
const aliasRegression = SUPPORTED_DIRECTORY_ALIAS_PLATFORMS.has(process.platform) ? it : it.skip;

function createLocalSettings(): MultiVaultSettings {
  return {
    vaults: [
      {
        id: 'a-ideas',
        name: 'Ideas',
        path: 'C:\\Vaults\\Ideas\\',
        enabled: true,
        color: '#FA0000',
        icon: 'lightbulb',
        includePatterns: ['Projects', 'Projects'],
        excludePatterns: ['Templates', 'Templates']
      },
      {
        id: 'z-ideas',
        name: 'Ideas duplicate',
        path: 'c:/vaults/ideas',
        enabled: false,
        color: 'not-a-color'
      },
      {
        id: 'medicine',
        name: 'Medicine',
        path: 'C:/Vaults/medicine/',
        enabled: true,
        color: '#00FF00',
        includePatterns: ['Notes', 'Notes'],
        excludePatterns: ['Private', 'Private']
      }
    ],
    indexOptions: {
      maxPreviewChars: 1000,
      autoRefreshOnStartup: true,
      globalExcludePatterns: ['.obsidian'],
      storeSnippetsInCache: true
    },
    savedSearches: [{ id: 'recent', name: 'Recent', query: 'tag:#recent' }],
    pinnedFiles: ['ideas:Projects/Roadmap.md'],
    uiStyle: 'modern',
    sharedSettingsEnabled: true,
    excludedVaultIds: ['z-ideas', 'medicine', 'medicine'],
    showCrossVaultBadge: false,
    useVaultColorForLinks: true,
    virtualLinks: {
      enabled: true,
      excludedSourceVaultIds: ['z-ideas', 'medicine', 'medicine'],
      targetVaultIdsBySource: {
        'z-ideas': ['medicine', 'medicine', 'a-ideas']
      },
      colorMode: 'soft-pill',
      colorIntensity: 91.4
    },
    sharedSettings: {
      lastAppliedRevision: 7,
      lastAppliedAt: '2026-08-10T12:00:00.000Z',
      localParticipationOverride: false
    }
  };
}

async function createDirectoryAlias(targetPath: string, aliasPath: string): Promise<void> {
  if (process.platform === 'win32') {
    await symlink(targetPath, aliasPath, 'junction');
    return;
  }

  await symlink(targetPath, aliasPath, 'dir');
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('path identity', () => {
  it('normalizes Windows path keys lexically', () => {
    expect(normalizePathKey('C:\\Users\\Jo\\Vault\\', 'win32')).toBe('c:/users/jo/vault');
    expect(normalizePathKey('C:/Users/Jo/Vault//', 'win32')).toBe('c:/users/jo/vault');
    expect(normalizePathKey('C:\\', 'win32')).toBe('c:/');
  });

  it('normalizes existing vault paths through realpath before keying', async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'mvn-shared-settings-'));
    tempDirs.push(tempRoot);

    const vaultDir = path.join(tempRoot, 'Vault');
    await mkdir(vaultDir);

    const expected = normalizePathKey(await realpath(vaultDir), process.platform);
    const candidate = path.join(tempRoot, '.', 'Vault', path.sep);

    await expect(normalizeVaultPath(candidate, process.platform)).resolves.toBe(expected);
  });
});

describe('shared settings projection', () => {
  aliasRegression('converges aliased vault paths to one realpath identity across projection and apply', async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'mvn-shared-settings-alias-'));
    tempDirs.push(tempRoot);

    const realVaultPath = path.join(tempRoot, 'Ideas');
    const aliasVaultPath = path.join(tempRoot, 'Ideas-alias');
    await mkdir(realVaultPath);
    await createDirectoryAlias(realVaultPath, aliasVaultPath);

    const projection = projectSharedSettings({
      ...createLocalSettings(),
      vaults: [
        {
          id: 'real-id',
          name: 'Ideas real',
          path: realVaultPath,
          enabled: true,
          color: '#AA0000'
        },
        {
          id: 'alias-id',
          name: 'Ideas alias',
          path: aliasVaultPath,
          enabled: false,
          color: '#00AA00'
        }
      ],
      excludedVaultIds: ['real-id', 'alias-id'],
      virtualLinks: {
        enabled: true,
        excludedSourceVaultIds: ['real-id', 'alias-id'],
        targetVaultIdsBySource: {
          'real-id': ['alias-id'],
          'alias-id': ['real-id']
        },
        colorMode: 'soft-pill',
        colorIntensity: 50
      }
    }, normalizePathKey(aliasVaultPath, process.platform));

    const expectedPathKey = normalizePathKey(await realpath(realVaultPath), process.platform);

    expect(projection.vaults).toEqual([
      {
        id: 'alias-id',
        name: 'Ideas alias',
        color: '#00AA00',
        enabled: false,
      }
    ]);
    expect(projection.excludedVaultIds).toEqual(['alias-id']);
    expect(projection.virtualLinks).toEqual({
      enabled: true,
      excludedSourceVaultIds: ['alias-id'],
      targetVaultIdsBySource: {
        'alias-id': ['alias-id']
      },
      colorMode: 'soft-pill',
      colorIntensity: 50
    });

    const applied = applySharedProjection({
      ...createLocalSettings(),
      vaults: [
        {
          id: 'local-alias',
          name: 'Local alias',
          path: aliasVaultPath,
          enabled: true,
          color: '#123456'
        }
      ]
    }, projection);

    expect(applied.vaults).toMatchObject([
      {
        id: 'alias-id',
        path: '',
        available: false,
        name: 'Ideas alias',
        color: '#00AA00',
        enabled: false,
      }
    ]);
  });

  aliasRegression('prefers the vault matching the current raw or canonical path when aliases share one real path', async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'mvn-shared-settings-current-'));
    tempDirs.push(tempRoot);

    const realVaultPath = path.join(tempRoot, 'Ideas');
    const aliasVaultPath = path.join(tempRoot, 'Ideas-alias');
    await mkdir(realVaultPath);
    await createDirectoryAlias(realVaultPath, aliasVaultPath);

    const localSettings: MultiVaultSettings = {
      ...createLocalSettings(),
      vaults: [
        {
          id: 'real-id',
          name: 'Ideas real',
          path: realVaultPath,
          enabled: true,
          color: '#AA0000'
        },
        {
          id: 'alias-id',
          name: 'Ideas alias',
          path: aliasVaultPath,
          enabled: true,
          color: '#00AA00'
        }
      ],
      excludedVaultIds: []
    };

    const rawCurrentProjection = projectSharedSettings(localSettings, normalizePathKey(aliasVaultPath, process.platform));
    expect(rawCurrentProjection.vaults[0].id).toBe('alias-id');

    const canonicalCurrentProjection = projectSharedSettings(
      localSettings,
      await normalizeVaultPath(aliasVaultPath, process.platform),
    );
    expect(canonicalCurrentProjection.vaults[0].id).toBe('real-id');
  });

  it('falls back to the first duplicate encountered when current path does not disambiguate', () => {
    const duplicatePath = 'C:/Vaults/Ideas';
    const projection = projectSharedSettings({
      ...createLocalSettings(),
      vaults: [
        {
          id: 'z-first',
          name: 'First duplicate',
          path: duplicatePath,
          enabled: true,
          color: '#ABCDEF'
        },
        {
          id: 'a-second',
          name: 'Second duplicate',
          path: duplicatePath,
          enabled: false,
          color: '#123456'
        }
      ],
      excludedVaultIds: ['z-first', 'a-second']
    }, 'c:/vaults/other');

    expect(projection.vaults).toEqual([
      {
        id: 'z-first',
        name: 'First duplicate',
        color: '#ABCDEF',
        enabled: true,
      }
    ]);
    expect(projection.excludedVaultIds).toEqual(['z-first']);
  });

  it('projects only shared settings, converges duplicate path identities, and clones deeply', () => {
    const localSettings = createLocalSettings();

    const projection = projectSharedSettings(localSettings, 'c:/vaults/ideas');

    expect(projection).toEqual({
      enabled: true,
      excludedVaultIds: ['a-ideas', 'medicine'],
      vaults: [
        {
          id: 'a-ideas',
          name: 'Ideas',
          color: '#FA0000',
          icon: 'lightbulb',
          enabled: true,
          includePatterns: ['Projects'],
          excludePatterns: ['Templates']
        },
        {
          id: 'medicine',
          name: 'Medicine',
          color: '#00FF00',
          enabled: true,
          includePatterns: ['Notes'],
          excludePatterns: ['Private']
        }
      ],
      crossVaultLinks: {
        showVaultBadge: false,
        useVaultColorForLinks: true
      },
      virtualLinks: {
        enabled: true,
        excludedSourceVaultIds: ['a-ideas', 'medicine'],
        targetVaultIdsBySource: {
          'a-ideas': ['medicine', 'a-ideas']
        },
        colorMode: 'soft-pill',
        colorIntensity: 90
      }
    });

    const projectionRecord = projection as unknown as Record<string, unknown>;
    expect('savedSearches' in projectionRecord).toBe(false);
    expect('pinnedFiles' in projectionRecord).toBe(false);
    expect('indexOptions' in projectionRecord).toBe(false);
    expect('sharedSettings' in projectionRecord).toBe(false);

    projection.vaults[0].includePatterns?.push('Mutated');
    projection.virtualLinks.excludedSourceVaultIds.push('later');

    expect(localSettings.vaults[0].includePatterns).toEqual(['Projects', 'Projects']);
    expect(localSettings.virtualLinks?.excludedSourceVaultIds).toEqual(['z-ideas', 'medicine', 'medicine']);
  });

  it('applies a shared projection by path key while preserving local-only settings', () => {
    const localSettings = createLocalSettings();

    const sharedProjection: SharedSettingsProjection = {
      enabled: false,
      excludedVaultIds: ['ideas-shared', 'ideas-shared', 'medicine-shared'],
      vaults: [
        {
          id: 'ideas-shared',
          pathKey: 'c:/vaults/ideas',
          path: 'C:/vaults/ideas',
          name: 'Ideas Shared',
          color: '#fa0000',
          icon: 'sparkles',
          enabled: true,
          includePatterns: ['Projects', 'Projects'],
          excludePatterns: ['Archive', 'Archive']
        },
        {
          id: 'medicine-shared',
          pathKey: 'c:/vaults/medicine',
          path: 'C:/vaults/medicine',
          name: 'Medicine Shared',
          color: '#12GG00',
          enabled: false
        }
      ],
      crossVaultLinks: {
        showVaultBadge: true,
        useVaultColorForLinks: false
      },
      virtualLinks: {
        enabled: true,
        excludedSourceVaultIds: ['ideas-shared', 'ideas-shared'],
        targetVaultIdsBySource: {
          'ideas-shared': ['medicine-shared', 'medicine-shared']
        },
        colorMode: 'soft-pill',
        colorIntensity: 9.2
      }
    };

    const applied = applySharedProjection(localSettings, sharedProjection);

    expect(applied.savedSearches).toEqual(localSettings.savedSearches);
    expect(applied.pinnedFiles).toEqual(localSettings.pinnedFiles);
    expect(applied.indexOptions).toEqual(localSettings.indexOptions);
    expect(applied.uiStyle).toBe(localSettings.uiStyle);
    expect(applied.sharedSettings).toEqual(localSettings.sharedSettings);

    expect(applied.sharedSettingsEnabled).toBe(false);
    expect(applied.excludedVaultIds).toEqual(['ideas-shared', 'medicine-shared']);
    expect(applied.showCrossVaultBadge).toBe(true);
    expect(applied.useVaultColorForLinks).toBe(false);
    expect(applied.virtualLinks).toEqual({
      enabled: true,
      excludedSourceVaultIds: ['ideas-shared'],
      targetVaultIdsBySource: {
        'ideas-shared': ['medicine-shared']
      },
      colorMode: 'soft-pill',
      colorIntensity: 10
    });

    expect(applied.vaults).toMatchObject([
      {
        id: 'ideas-shared',
        path: 'c:/vaults/ideas',
        name: 'Ideas Shared',
        color: '#fa0000',
        icon: 'sparkles',
        enabled: true,
        includePatterns: ['Projects'],
        excludePatterns: ['Archive']
      },
      {
        id: 'medicine-shared',
        path: 'C:/Vaults/medicine/',
        name: 'Medicine Shared',
        enabled: false
      }
    ]);

    expect(applied.vaults.find((vault) => vault.path.endsWith('ideas'))?.color).toBe('#fa0000');

    applied.savedSearches[0].name = 'Changed';
    applied.pinnedFiles.push('new-pin');
    applied.vaults[0].includePatterns?.push('Mutated');
    applied.virtualLinks?.excludedSourceVaultIds.push('later');

    expect(localSettings.savedSearches[0].name).toBe('Recent');
    expect(localSettings.pinnedFiles).toEqual(['ideas:Projects/Roadmap.md']);
    expect(localSettings.vaults[0].includePatterns).toEqual(['Projects', 'Projects']);
    expect(localSettings.virtualLinks?.excludedSourceVaultIds).toEqual(['z-ideas', 'medicine', 'medicine']);
  });
});
