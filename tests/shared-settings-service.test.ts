import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { App, FileSystemAdapter } from 'obsidian';

import {
  SharedSettingsService,
  type SharedSettingsRuntime,
} from '../src/shared-settings/shared-settings-service';
import {
  SHARED_SETTINGS_PATCH_DIRECTORY_NAME,
  SharedSettingsStore,
} from '../src/shared-settings/shared-settings-store';
import { normalizePathKey } from '../src/shared-settings/path-identity';
import type { SharedSettingsProjection } from '../src/shared-settings/shared-settings-types';
import type { MultiVaultSettings } from '../src/types';
import { VaultRegistry } from '../src/vault-registry';

const tempDirs: string[] = [];

function localSettings(color = '#111111'): MultiVaultSettings {
  return {
    vaults: [
      { id: 'ideas', name: 'Ideas', path: '/vaults/ideas', enabled: true, color: '#fa0000' },
      { id: 'medicine', name: 'Medicine', path: '/vaults/medicine', enabled: true, color },
      { id: 'hobbies', name: 'Hobbies', path: '/vaults/hobbies', enabled: true },
      { id: 'mathematics', name: 'Mathematics', path: '/vaults/mathematics', enabled: true },
    ],
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
    useVaultColorForLinks: false,
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

function projection(excludedVaultIds: string[] = []): SharedSettingsProjection {
  const settings = localSettings();
  return {
    enabled: true,
    excludedVaultIds,
    vaults: settings.vaults.map((vault) => ({
      ...vault,
      pathKey: normalizePathKey(vault.path, process.platform),
    })),
    crossVaultLinks: {
      showVaultBadge: true,
      useVaultColorForLinks: false,
    },
    virtualLinks: settings.virtualLinks!,
  };
}

function settingsForVaults(vaults: MultiVaultSettings['vaults']): MultiVaultSettings {
  return {
    ...localSettings(),
    vaults: vaults.map((vault) => ({ ...vault })),
    sharedSettings: {},
  };
}

async function createVaultDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(directory);
  await mkdir(path.join(directory, '.obsidian'), { recursive: true });
  return directory;
}

async function fixture(excludedVaultIds: string[] = []) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mvn-shared-service-'));
  tempDirs.push(root);
  const store = new SharedSettingsStore(root);
  await store.initialize(projection(excludedVaultIds), 'seed-writer');
  return { root, store };
}

function service(
  store: SharedSettingsStore,
  settings: MultiVaultSettings,
  vaultId: 'ideas' | 'medicine' | 'hobbies' | 'mathematics',
  writerInstanceId = `${vaultId}-writer`,
): SharedSettingsService {
  return new SharedSettingsService({
    store,
    settings,
    currentVaultPath: `/vaults/${vaultId}`,
    writerInstanceId,
    polling: false,
  });
}

function runtime(overrides: Partial<SharedSettingsRuntime> = {}): SharedSettingsRuntime {
  return {
    replaceVaults: vi.fn(),
    saveLocalMirror: vi.fn(async () => undefined),
    onAppearanceChanged: vi.fn(),
    onCatalogChanged: vi.fn(),
    ...overrides,
  };
}

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('SharedSettingsService lifecycle', () => {
  it('applies an enabled peer patch and lets a closed peer catch up on initialize', async () => {
    const { root, store } = await fixture();
    const ideasSettings = localSettings();
    const medicineSettings = localSettings();
    const ideas = service(store, ideasSettings, 'ideas');
    const medicine = service(new SharedSettingsStore(root), medicineSettings, 'medicine');

    await ideas.initialize();
    await medicine.initialize();
    const medicineRuntime = runtime();
    medicine.attachRuntime(medicineRuntime);

    await ideas.publish({ kind: 'set-vault-color', vaultId: 'medicine', color: '#abcdef' });
    const applied = await medicine.applyLatest();

    expect(applied).toMatchObject({
      kind: 'applied',
      appearanceChanged: true,
      catalogChanged: false,
    });
    expect(medicineSettings.vaults.find((vault) => vault.id === 'medicine')?.color).toBe('#abcdef');
    expect(medicineRuntime.onCatalogChanged).not.toHaveBeenCalled();
    expect(medicineRuntime.onAppearanceChanged).toHaveBeenCalledTimes(1);

    const closedSettings = localSettings('#222222');
    const closedPeer = service(new SharedSettingsStore(root), closedSettings, 'hobbies');
    await expect(closedPeer.initialize()).resolves.toMatchObject({ kind: 'applied', revision: 1 });
    expect(closedSettings.vaults.find((vault) => vault.id === 'medicine')?.color).toBe('#abcdef');
    expect(closedSettings.savedSearches[0].name).toBe('Local only');
  });

  it('does not apply or publish from an excluded peer', async () => {
    const { store } = await fixture(['hobbies']);
    const hobbiesSettings = localSettings('#222222');
    const hobbies = service(store, hobbiesSettings, 'hobbies');

    await expect(hobbies.initialize()).resolves.toEqual({ kind: 'excluded', revision: 0 });
    await expect(hobbies.publish({
      kind: 'set-vault-color',
      vaultId: 'medicine',
      color: '#abcdef',
    })).resolves.toEqual({ kind: 'excluded', revision: 0 });

    expect((await store.read())?.revision).toBe(0);
    expect(hobbiesSettings.vaults.find((vault) => vault.id === 'medicine')?.color).toBe('#222222');
  });

  it('allows the explicit global control patch to re-enable a disabled journal', async () => {
    const { store } = await fixture();
    await store.patch({ kind: 'set-enabled', enabled: false }, 'administrator');
    const settings = localSettings('#222222');
    const medicine = service(store, settings, 'medicine');

    await expect(medicine.initialize()).resolves.toEqual({ kind: 'disabled', revision: 1 });
    await expect(medicine.publish({ kind: 'set-enabled', enabled: true })).resolves.toMatchObject({
      kind: 'applied',
      revision: 2,
    });
    expect((await store.read())?.enabled).toBe(true);
    expect(settings.sharedSettingsEnabled).toBe(true);
  });

  it('leaves the local mirror untouched while synchronization is globally disabled', async () => {
    const { store } = await fixture();
    await store.patch({ kind: 'set-enabled', enabled: false }, 'administrator');
    const medicineSettings = localSettings('#222222');
    const medicine = service(store, medicineSettings, 'medicine');

    await expect(medicine.initialize()).resolves.toEqual({ kind: 'disabled', revision: 1 });
    await expect(medicine.publish({
      kind: 'set-vault-color',
      vaultId: 'medicine',
      color: '#abcdef',
    })).resolves.toEqual({ kind: 'disabled', revision: 1 });

    expect(medicineSettings.vaults.find((vault) => vault.id === 'medicine')?.color).toBe('#222222');
    expect(medicineSettings.sharedSettingsEnabled).toBe(false);
    expect((await store.read())?.revision).toBe(1);
  });

  it('preserves a local mirror when the journal is absent or invalid', async () => {
    const absentRoot = await mkdtemp(path.join(os.tmpdir(), 'mvn-shared-service-absent-'));
    tempDirs.push(absentRoot);
    const absentSettings = localSettings('#222222');
    const absent = service(new SharedSettingsStore(absentRoot), absentSettings, 'medicine');

    await expect(absent.initialize()).resolves.toEqual({ kind: 'unchanged', revision: null });
    expect(absentSettings.vaults.find((vault) => vault.id === 'medicine')?.color).toBe('#222222');

    const { root, store } = await fixture();
    const invalidSettings = localSettings('#333333');
    const invalid = service(store, invalidSettings, 'medicine');
    await mkdir(path.join(store.directory, SHARED_SETTINGS_PATCH_DIRECTORY_NAME), { recursive: true });
    await writeFile(
      path.join(store.directory, SHARED_SETTINGS_PATCH_DIRECTORY_NAME, 'invalid.json'),
      '{ invalid JSON',
      'utf8',
    );

    const result = await invalid.initialize();
    expect(result.kind).toBe('error');
    expect(invalidSettings.vaults.find((vault) => vault.id === 'medicine')?.color).toBe('#333333');
    expect(invalid.getStatus()).toMatchObject({ revision: null, lastAppliedRevision: null });
    expect(invalid.getStatus().error).toContain('malformed JSON');
    expect(root).toBe(store.applicationDataRoot);
  });

  it('keeps an authoritative startup projection exact by skipping vault auto-detection', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'mvn-shared-service-startup-'));
    tempDirs.push(root);
    const currentVault = await createVaultDirectory('mvn-current-vault-');
    const sharedVault = await createVaultDirectory('mvn-shared-vault-');
    const strayVault = await createVaultDirectory('mvn-stray-vault-');
    const appDataRoot = await mkdtemp(path.join(os.tmpdir(), 'mvn-obsidian-appdata-'));
    tempDirs.push(appDataRoot);
    await mkdir(path.join(appDataRoot, 'Obsidian'), { recursive: true });
    await writeFile(
      path.join(appDataRoot, 'Obsidian', 'obsidian.json'),
      JSON.stringify({
        vaults: {
          current: { path: currentVault },
          shared: { path: sharedVault },
          stray: { path: strayVault },
        },
      }),
      'utf8',
    );
    vi.spyOn(os, 'platform').mockReturnValue('win32');
    vi.stubEnv('APPDATA', appDataRoot);

    const settings = settingsForVaults([
      { id: 'current', name: 'Current', path: currentVault, enabled: true, color: '#111111' },
      { id: 'local-only', name: 'Local only', path: strayVault, enabled: true },
    ]);
    const store = new SharedSettingsStore(root);
    await store.initialize({
      enabled: true,
      excludedVaultIds: [],
      vaults: [
        { id: 'current', name: 'Current', path: currentVault, pathKey: normalizePathKey(currentVault, process.platform), enabled: true, color: '#111111' },
        { id: 'shared', name: 'Shared', path: sharedVault, pathKey: normalizePathKey(sharedVault, process.platform), enabled: true, color: '#222222' },
      ],
      crossVaultLinks: {
        showVaultBadge: true,
        useVaultColorForLinks: false,
      },
      virtualLinks: settings.virtualLinks!,
    }, 'seed-writer');

    const peer = new SharedSettingsService({
      store,
      settings,
      currentVaultPath: currentVault,
      writerInstanceId: 'current-writer',
      polling: false,
    });

    await expect(peer.initialize()).resolves.toMatchObject({ kind: 'applied', revision: 0 });
    expect(peer.hasAuthoritativeManifest()).toBe(true);
    expect(settings.vaults.map((vault) => vault.id).sort()).toEqual(['current', 'shared']);

    const adapter = Object.assign(new FileSystemAdapter(), {
      getBasePath: () => currentVault,
    });
    const app = {
      vault: {
        configDir: '.obsidian',
        adapter,
      },
    } as unknown as App;

    expect(new VaultRegistry(app, settings).getVaults().map((vault) => vault.id)).toContain('stray');
    expect(
      new VaultRegistry(app, settings, { autoDetect: !peer.hasAuthoritativeManifest() })
        .getVaults()
        .map((vault) => vault.id)
        .sort(),
    ).toEqual(['current', 'shared']);
  });

  it('reapplies the latest journal state when forced even at the same revision', async () => {
    const { root, store } = await fixture();
    const settings = localSettings();
    const peer = service(new SharedSettingsStore(root), settings, 'medicine');

    await expect(peer.initialize()).resolves.toMatchObject({ kind: 'applied', revision: 0 });
    settings.vaults.find((vault) => vault.id === 'medicine')!.color = '#222222';

    const callbacks = runtime();
    peer.attachRuntime(callbacks);

    await expect(peer.applyLatest()).resolves.toEqual({ kind: 'unchanged', revision: 0 });
    expect(settings.vaults.find((vault) => vault.id === 'medicine')?.color).toBe('#222222');

    await expect(peer.applyLatest(true)).resolves.toMatchObject({
      kind: 'applied',
      revision: 0,
      appearanceChanged: true,
      catalogChanged: false,
    });
    expect(settings.vaults.find((vault) => vault.id === 'medicine')?.color).toBe('#111111');
    expect(callbacks.saveLocalMirror).toHaveBeenCalledTimes(1);
    expect(callbacks.onAppearanceChanged).toHaveBeenCalledTimes(1);
    expect(callbacks.onCatalogChanged).not.toHaveBeenCalled();
  });

  it('coalesces catalog revisions into one incremental refresh request', async () => {
    const { root, store } = await fixture();
    const medicineSettings = localSettings();
    const medicine = service(new SharedSettingsStore(root), medicineSettings, 'medicine');
    await medicine.initialize();
    const refreshIncremental = vi.fn(async () => undefined);
    const medicineRuntime = runtime({ onCatalogChanged: refreshIncremental });
    medicine.attachRuntime(medicineRuntime);

    await store.patch({ kind: 'set-vault-enabled', vaultId: 'hobbies', enabled: false }, 'ideas');
    await store.patch({
      kind: 'set-vault-patterns',
      vaultId: 'medicine',
      include: ['Notes'],
      exclude: ['Private'],
    }, 'ideas');

    await expect(medicine.applyLatest()).resolves.toMatchObject({
      kind: 'applied',
      revision: 2,
      catalogChanged: true,
    });
    expect(refreshIncremental).toHaveBeenCalledTimes(1);
    expect(refreshIncremental).toHaveBeenCalledWith();
    expect(medicineRuntime.onAppearanceChanged).not.toHaveBeenCalled();
  });

  it('polls journal metadata with one owned interval and disposes the timer', async () => {
    const { root, store } = await fixture();
    const settings = localSettings();
    let poll: (() => void) | null = null;
    const timer = { id: 1 } as unknown as ReturnType<typeof globalThis.setInterval>;
    const clearInterval = vi.fn();
    const registerInterval = vi.fn();
    const peer = new SharedSettingsService({
      store: new SharedSettingsStore(root),
      settings,
      currentVaultPath: '/vaults/medicine',
      writerInstanceId: 'medicine-writer',
      pollIntervalMs: 10,
      setInterval: (callback) => {
        poll = callback;
        return timer;
      },
      clearInterval,
      registerInterval,
    });
    await peer.initialize();
    peer.attachRuntime(runtime());
    peer.attachRuntime(runtime());

    expect(registerInterval).toHaveBeenCalledTimes(1);
    await store.patch({ kind: 'set-vault-color', vaultId: 'medicine', color: '#abcdef' }, 'ideas');
    (poll as (() => void) | null)?.();
    await vi.waitFor(() => {
      expect(settings.vaults.find((vault) => vault.id === 'medicine')?.color).toBe('#abcdef');
    });

    peer.dispose();
    expect(clearInterval).toHaveBeenCalledOnce();
    expect(clearInterval).toHaveBeenCalledWith(timer);
  });

  it('refreshes only decorations for appearance changes and disposes callbacks', async () => {
    const { root, store } = await fixture();
    const settings = localSettings();
    const peer = service(new SharedSettingsStore(root), settings, 'medicine');
    await peer.initialize();
    const callbacks = runtime();
    peer.attachRuntime(callbacks);

    await store.patch({
      kind: 'set-cross-vault-appearance',
      showBadge: false,
      useColor: true,
    }, 'ideas');
    await peer.applyLatest();

    expect(callbacks.onAppearanceChanged).toHaveBeenCalledTimes(1);
    expect(callbacks.onCatalogChanged).not.toHaveBeenCalled();

    peer.dispose();
    await store.patch({ kind: 'set-vault-color', vaultId: 'ideas', color: '#123456' }, 'ideas');
    await expect(peer.applyLatest()).resolves.toMatchObject({ kind: 'error' });
    expect(callbacks.onAppearanceChanged).toHaveBeenCalledTimes(1);
  });
});
