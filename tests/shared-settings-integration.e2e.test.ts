import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { SharedSettingsService } from '../src/shared-settings/shared-settings-service';
import { SharedSettingsStore } from '../src/shared-settings/shared-settings-store';
import { normalizeExistingPathKey } from '../src/shared-settings/path-identity';
import type { SharedSettingsProjection } from '../src/shared-settings/shared-settings-types';
import type { MultiVaultSettings } from '../src/types';

const { readPaths } = vi.hoisted(() => ({ readPaths: [] as string[] }));

vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  return {
    ...actual,
    default: actual,
    readFile: (file: Parameters<typeof actual.readFile>[0], ...rest: unknown[]) => {
      readPaths.push(String(file));
      return (actual.readFile as (...args: unknown[]) => unknown)(file, ...rest);
    },
  };
});

type VaultKey = 'ideas' | 'hobbies' | 'mathematics' | 'medicine';

const VAULT_KEYS: VaultKey[] = ['ideas', 'hobbies', 'mathematics', 'medicine'];
const SEED_COLORS: Record<VaultKey, string> = {
  ideas: '#fa0000',
  hobbies: '#1fe1e5',
  mathematics: '#d4c30c',
  medicine: '#ac20df',
};

const tempDirs: string[] = [];
let vaultPaths: Record<VaultKey, string>;
let sharedRoot: string;

/** A real on-disk vault with a note and a plugin cache the shared journal must never read. */
async function createVault(key: VaultKey): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), `mvn-e2e-${key}-`));
  tempDirs.push(directory);
  const pluginDirectory = path.join(directory, '.obsidian', 'plugins', 'multi-vault-navigator');
  await mkdir(pluginDirectory, { recursive: true });
  await writeFile(path.join(directory, 'Note.md'), `# ${key}\nprivate note body\n`, 'utf8');
  await writeFile(path.join(pluginDirectory, 'index-cache.json'), '{"files":[]}', 'utf8');
  return directory;
}

function localSettings(): MultiVaultSettings {
  return {
    vaults: VAULT_KEYS.map((key) => ({
      id: key,
      name: key[0].toUpperCase() + key.slice(1),
      path: vaultPaths[key],
      enabled: true,
      color: SEED_COLORS[key],
    })),
    indexOptions: {
      maxPreviewChars: 1000,
      autoRefreshOnStartup: false,
      globalExcludePatterns: [],
      storeSnippetsInCache: true,
    },
    savedSearches: [{ id: 'local', name: 'Local only', query: 'local' }],
    pinnedFiles: ['local.md'],
    sharedSettingsEnabled: true,
    excludedVaultIds: [],
    showCrossVaultBadge: true,
    useVaultColorForLinks: true,
    virtualLinks: {
      enabled: false,
      excludedSourceVaultIds: [],
      targetVaultIdsBySource: {},
      colorMode: 'soft-pill',
      colorIntensity: 55,
    },
    sharedSettings: {},
  };
}

function seedProjection(excludedVaultIds: string[]): SharedSettingsProjection {
  return {
    enabled: true,
    excludedVaultIds,
    vaults: VAULT_KEYS.map((key) => ({
      id: key,
      name: key[0].toUpperCase() + key.slice(1),
      path: vaultPaths[key],
      pathKey: normalizeExistingPathKey(vaultPaths[key], process.platform),
      enabled: true,
      color: SEED_COLORS[key],
    })),
    crossVaultLinks: { showVaultBadge: true, useVaultColorForLinks: true },
    virtualLinks: {
      enabled: false,
      excludedSourceVaultIds: [],
      targetVaultIdsBySource: {},
      colorMode: 'soft-pill',
      colorIntensity: 55,
    },
  };
}

interface Peer {
  key: VaultKey;
  settings: MultiVaultSettings;
  service: SharedSettingsService;
}

/** Each peer gets its own store handle, exactly like four separate Obsidian processes. */
function peer(key: VaultKey, settings: MultiVaultSettings = localSettings()): Peer {
  return {
    key,
    settings,
    service: new SharedSettingsService({
      store: new SharedSettingsStore(sharedRoot),
      settings,
      currentVaultPath: vaultPaths[key],
      writerInstanceId: `${key}-writer`,
      polling: false,
    }),
  };
}

function colorOf(settings: MultiVaultSettings, vaultId: VaultKey): string | undefined {
  return settings.vaults.find((vault) => vault.id === vaultId)?.color;
}

beforeEach(async () => {
  readPaths.length = 0;
  const created = await Promise.all(VAULT_KEYS.map((key) => createVault(key)));
  vaultPaths = Object.fromEntries(VAULT_KEYS.map((key, index) => [key, created[index]])) as Record<VaultKey, string>;
  sharedRoot = await mkdtemp(path.join(os.tmpdir(), 'mvn-e2e-shared-'));
  tempDirs.push(sharedRoot);
});

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('four-vault shared configuration convergence', () => {
  it('converges participating peers, keeps an excluded peer local, and catches a restarted peer up', async () => {
    // Ideas seeds the store after its preview is confirmed. Mathematics opts out.
    const seedStore = new SharedSettingsStore(sharedRoot);
    await seedStore.initialize(seedProjection(['mathematics']), 'ideas-writer');

    const ideas = peer('ideas');
    const hobbies = peer('hobbies');
    const mathematics = peer('mathematics');
    const medicine = peer('medicine');

    expect(await ideas.service.initializeAndApplyToSettings()).toMatchObject({ kind: 'applied' });
    expect(await hobbies.service.initializeAndApplyToSettings()).toMatchObject({ kind: 'applied' });
    expect(await medicine.service.initializeAndApplyToSettings()).toMatchObject({ kind: 'applied' });
    expect(await mathematics.service.initializeAndApplyToSettings()).toMatchObject({ kind: 'excluded' });

    // Hobbies recolors Medicine and opens Virtual Linker scope from Ideas to Medicine.
    expect(await hobbies.service.publish({
      kind: 'set-vault-color', vaultId: 'medicine', color: '#123456',
    })).toMatchObject({ kind: 'applied', appearanceChanged: true });
    expect(await hobbies.service.publish({ kind: 'set-virtual-links-enabled', enabled: true }))
      .toMatchObject({ kind: 'applied', catalogChanged: true });
    expect(await hobbies.service.publish({
      kind: 'set-virtual-link-targets', sourceVaultId: 'ideas', targetVaultIds: ['medicine'],
    })).toMatchObject({ kind: 'applied', catalogChanged: true });

    // Participating peers converge on the same authoritative state.
    expect(await ideas.service.applyLatest()).toMatchObject({ kind: 'applied', revision: 3 });
    expect(await medicine.service.applyLatest()).toMatchObject({ kind: 'applied', revision: 3 });
    for (const converged of [ideas.settings, hobbies.settings, medicine.settings]) {
      expect(colorOf(converged, 'medicine')).toBe('#123456');
      expect(converged.virtualLinks).toMatchObject({
        enabled: true,
        targetVaultIdsBySource: { ideas: ['medicine'] },
      });
    }

    // The excluded peer reads status but neither applies nor publishes.
    expect(await mathematics.service.applyLatest()).toMatchObject({ kind: 'excluded' });
    expect(colorOf(mathematics.settings, 'medicine')).toBe(SEED_COLORS.medicine);
    expect(mathematics.settings.virtualLinks?.enabled).toBe(false);
    expect(await mathematics.service.publish({
      kind: 'set-vault-excluded', vaultId: 'mathematics', excluded: false,
    })).toMatchObject({ kind: 'excluded' });
    expect((await new SharedSettingsStore(sharedRoot).read())?.excludedVaultIds).toEqual(['mathematics']);

    // A peer that was closed for the whole exchange catches up from its own local mirror.
    const restarted = peer('medicine');
    expect(colorOf(restarted.settings, 'medicine')).toBe(SEED_COLORS.medicine);
    expect(await restarted.service.initializeAndApplyToSettings())
      .toMatchObject({ kind: 'applied', revision: 3 });
    expect(colorOf(restarted.settings, 'medicine')).toBe('#123456');
    expect(restarted.settings.sharedSettings?.lastAppliedRevision).toBe(3);

    // Local-only settings survive every applied projection.
    expect(restarted.settings.savedSearches).toEqual([{ id: 'local', name: 'Local only', query: 'local' }]);
    expect(restarted.settings.pinnedFiles).toEqual(['local.md']);

    // Ideas can lift the exclusion; Mathematics then converges too.
    expect(await ideas.service.publish({
      kind: 'set-vault-excluded', vaultId: 'mathematics', excluded: false,
    })).toMatchObject({ kind: 'applied' });
    expect(await mathematics.service.applyLatest()).toMatchObject({ kind: 'applied', revision: 4 });
    expect(colorOf(mathematics.settings, 'medicine')).toBe('#123456');

    for (const active of [ideas, hobbies, medicine, mathematics, restarted]) active.service.dispose();

    // Configuration exchange must never touch note content or index caches.
    // (Guard the guard: the recorder must have observed the journal reads themselves.)
    expect(readPaths.some((readPath) => readPath.endsWith('seed.json'))).toBe(true);
    const vaultDirectories = VAULT_KEYS.map((key) => normalizeExistingPathKey(vaultPaths[key], process.platform));
    const trespass = readPaths
      .map((readPath) => normalizeExistingPathKey(readPath, process.platform))
      .filter((readPath) => vaultDirectories.some((directory) => readPath.startsWith(`${directory}/`)));
    expect(trespass).toEqual([]);
  });
});
