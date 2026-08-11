import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  SHARED_SETTINGS_LOCK_FILE_NAME,
  SHARED_SETTINGS_MANIFEST_FILE_NAME,
  SharedSettingsStore,
  type SharedSettingsPatch,
} from '../src/shared-settings/shared-settings-store';
import {
  InvalidSharedSettingsError,
  MalformedSharedSettingsError,
  SharedSettingsLockTimeoutError,
  UnsupportedSharedSettingsVersionError,
} from '../src/shared-settings/shared-settings-errors';
import type { SharedSettingsProjection } from '../src/shared-settings/shared-settings-types';

const tempDirs: string[] = [];

function createProjection(): SharedSettingsProjection {
  return {
    enabled: true,
    excludedVaultIds: [],
    vaults: [
      {
        id: 'ideas',
        pathKey: 'c:/vaults/ideas',
        path: 'C:/Vaults/Ideas',
        name: 'Ideas',
        color: '#abcdef',
        enabled: true,
      },
      {
        id: 'medicine',
        pathKey: 'c:/vaults/medicine',
        path: 'C:/Vaults/Medicine',
        name: 'Medicine',
        enabled: true,
      },
    ],
    crossVaultLinks: {
      showVaultBadge: true,
      useVaultColorForLinks: false,
    },
    virtualLinks: {
      enabled: false,
      excludedSourceVaultIds: [],
      targetVaultIdsBySource: {},
      colorMode: 'soft-pill',
      colorIntensity: 55,
    },
  };
}

async function createStore(
  options: ConstructorParameters<typeof SharedSettingsStore>[1] = {},
): Promise<{ directory: string; store: SharedSettingsStore }> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'mvn-shared-store-'));
  tempDirs.push(directory);
  return { directory, store: new SharedSettingsStore(directory, options) };
}

async function readRawManifest(directory: string): Promise<Record<string, unknown>> {
  const content = await readFile(path.join(directory, SHARED_SETTINGS_MANIFEST_FILE_NAME), 'utf8');
  return JSON.parse(content) as Record<string, unknown>;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('SharedSettingsStore', () => {
  it('returns null when the manifest is absent and initializes revision one', async () => {
    const { directory, store } = await createStore();

    await expect(store.read()).resolves.toBeNull();
    const initialized = await store.initialize(createProjection(), 'ideas-instance');

    expect(initialized).toMatchObject({
      schemaVersion: 1,
      revision: 1,
      writerInstanceId: 'ideas-instance',
      enabled: true,
    });
    expect(Number.isNaN(Date.parse(initialized.updatedAt))).toBe(false);
    await expect(store.read()).resolves.toEqual(initialized);
    await expect(stat(path.join(directory, SHARED_SETTINGS_LOCK_FILE_NAME))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('applies every explicit patch and increments the revision monotonically', async () => {
    const { store } = await createStore();
    await store.initialize(createProjection(), 'initializer');

    const patches: SharedSettingsPatch[] = [
      { kind: 'set-enabled', enabled: false },
      { kind: 'set-vault-excluded', vaultId: 'medicine', excluded: true },
      {
        kind: 'upsert-vault',
        vault: {
          id: 'research',
          pathKey: 'c:/vaults/research',
          path: 'C:/Vaults/Research',
          name: 'Research',
          enabled: true,
        },
      },
      { kind: 'set-vault-color', vaultId: 'ideas', color: '#112233' },
      { kind: 'set-vault-icon', vaultId: 'ideas', icon: 'brain' },
      { kind: 'set-vault-enabled', vaultId: 'ideas', enabled: false },
      { kind: 'set-vault-patterns', vaultId: 'ideas', include: ['Notes'], exclude: ['Archive'] },
      { kind: 'set-cross-vault-appearance', showBadge: false, useColor: true },
      { kind: 'set-virtual-links-enabled', enabled: true },
      { kind: 'set-virtual-link-source-excluded', vaultId: 'medicine', excluded: true },
      { kind: 'set-virtual-link-targets', sourceVaultId: 'ideas', targetVaultIds: ['medicine'] },
      { kind: 'set-virtual-link-style', mode: 'colored-underline', intensity: 70 },
      { kind: 'remove-vault', vaultId: 'research' },
    ];

    for (const [index, patch] of patches.entries()) {
      const saved = await store.patch(patch, `writer-${index}`);
      expect(saved.revision).toBe(index + 2);
      expect(saved.writerInstanceId).toBe(`writer-${index}`);
    }

    const saved = await store.read();
    expect(saved).toMatchObject({
      enabled: false,
      excludedVaultIds: ['medicine'],
      crossVaultLinks: { showVaultBadge: false, useVaultColorForLinks: true },
      virtualLinks: {
        enabled: true,
        excludedSourceVaultIds: ['medicine'],
        targetVaultIdsBySource: { ideas: ['medicine'] },
        colorMode: 'colored-underline',
        colorIntensity: 70,
      },
    });
    expect(saved?.vaults).toHaveLength(2);
    expect(saved?.vaults[0]).toMatchObject({
      id: 'ideas',
      color: '#112233',
      icon: 'brain',
      enabled: false,
      includePatterns: ['Notes'],
      excludePatterns: ['Archive'],
    });
  });

  it('preserves unknown extensions and unknown fields during read-modify-write', async () => {
    const { directory, store } = await createStore();
    await store.initialize(createProjection(), 'initializer');

    const raw = await readRawManifest(directory);
    raw.extensions = { thirdParty: { version: 2, values: ['kept'] } };
    raw.futureTopLevelField = { enabled: true };
    (raw.vaults as Array<Record<string, unknown>>)[0].futureVaultField = 'kept';
    await writeFile(
      path.join(directory, SHARED_SETTINGS_MANIFEST_FILE_NAME),
      `${JSON.stringify(raw, null, 2)}\n`,
      'utf8',
    );

    await store.patch({ kind: 'set-vault-color', vaultId: 'ideas', color: '#123456' }, 'writer');

    const saved = await readRawManifest(directory);
    expect(saved.extensions).toEqual({ thirdParty: { version: 2, values: ['kept'] } });
    expect(saved.futureTopLevelField).toEqual({ enabled: true });
    expect((saved.vaults as Array<Record<string, unknown>>)[0].futureVaultField).toBe('kept');
  });

  it('merges disjoint concurrent patches from independent store instances', async () => {
    const { directory, store: storeA } = await createStore();
    const storeB = new SharedSettingsStore(directory);
    await storeA.initialize(createProjection(), 'initializer');

    await Promise.all([
      storeA.patch({ kind: 'set-vault-color', vaultId: 'ideas', color: '#112233' }, 'writer-a'),
      storeB.patch({ kind: 'set-vault-icon', vaultId: 'ideas', icon: 'brain' }, 'writer-b'),
    ]);

    const saved = await storeA.read();
    expect(saved?.vaults[0]).toMatchObject({ color: '#112233', icon: 'brain' });
    expect(saved?.revision).toBe(3);
  });

  it('serializes same-field concurrent patches without losing a revision', async () => {
    const { directory, store: storeA } = await createStore();
    const storeB = new SharedSettingsStore(directory);
    await storeA.initialize(createProjection(), 'initializer');

    const results = await Promise.all([
      storeA.patch({ kind: 'set-vault-color', vaultId: 'ideas', color: '#111111' }, 'writer-a'),
      storeB.patch({ kind: 'set-vault-color', vaultId: 'ideas', color: '#222222' }, 'writer-b'),
    ]);

    expect(results.map((result) => result.revision).sort()).toEqual([2, 3]);
    const saved = await storeA.read();
    expect(saved?.revision).toBe(3);
    expect(['#111111', '#222222']).toContain(saved?.vaults[0].color);
  });

  it('times out after bounded retry while a live lock exists', async () => {
    const { directory, store } = await createStore({
      lockTimeoutMs: 80,
      retryMinMs: 5,
      retryMaxMs: 10,
    });
    await store.initialize(createProjection(), 'initializer');
    const lockPath = path.join(directory, SHARED_SETTINGS_LOCK_FILE_NAME);
    await writeFile(lockPath, 'other-owner', { flag: 'wx' });

    const startedAt = Date.now();
    await expect(
      store.patch({ kind: 'set-enabled', enabled: false }, 'blocked-writer'),
    ).rejects.toBeInstanceOf(SharedSettingsLockTimeoutError);
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(60);
    expect(Date.now() - startedAt).toBeLessThan(1_000);
    await expect(readFile(lockPath, 'utf8')).resolves.toBe('other-owner');
  });

  it('rechecks and expires a lock older than thirty seconds', async () => {
    const { directory, store } = await createStore({ retryMinMs: 1, retryMaxMs: 2 });
    await store.initialize(createProjection(), 'initializer');
    const lockPath = path.join(directory, SHARED_SETTINGS_LOCK_FILE_NAME);
    await writeFile(lockPath, 'abandoned-owner', { flag: 'wx' });
    const oldTime = new Date(Date.now() - 31_000);
    await utimes(lockPath, oldTime, oldTime);

    const saved = await store.patch({ kind: 'set-enabled', enabled: false }, 'new-owner');

    expect(saved).toMatchObject({ revision: 2, enabled: false, writerInstanceId: 'new-owner' });
    await expect(stat(lockPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects malformed JSON without treating it as an absent manifest', async () => {
    const { directory, store } = await createStore();
    const manifestPath = path.join(directory, SHARED_SETTINGS_MANIFEST_FILE_NAME);
    await writeFile(manifestPath, '{ definitely not JSON', 'utf8');

    await expect(store.read()).rejects.toBeInstanceOf(MalformedSharedSettingsError);
    await expect(
      store.patch({ kind: 'set-enabled', enabled: true }, 'writer'),
    ).rejects.toBeInstanceOf(MalformedSharedSettingsError);
    await expect(readFile(manifestPath, 'utf8')).resolves.toBe('{ definitely not JSON');
  });

  it('rejects schema-invalid manifests and invalid patch results without rewriting', async () => {
    const { directory, store } = await createStore();
    const manifestPath = path.join(directory, SHARED_SETTINGS_MANIFEST_FILE_NAME);
    await store.initialize(createProjection(), 'initializer');

    const validContent = await readFile(manifestPath, 'utf8');
    await expect(
      store.patch({ kind: 'set-vault-color', vaultId: 'ideas', color: 'red' }, 'writer'),
    ).rejects.toBeInstanceOf(InvalidSharedSettingsError);
    await expect(readFile(manifestPath, 'utf8')).resolves.toBe(validContent);

    const invalid = JSON.parse(validContent) as Record<string, unknown>;
    invalid.revision = 'one';
    await writeFile(manifestPath, JSON.stringify(invalid), 'utf8');
    await expect(store.read()).rejects.toBeInstanceOf(InvalidSharedSettingsError);
    await expect(
      store.patch({ kind: 'set-enabled', enabled: false }, 'writer'),
    ).rejects.toBeInstanceOf(InvalidSharedSettingsError);
  });

  it('rejects unsupported future versions without rewriting them', async () => {
    const { directory, store } = await createStore();
    const manifestPath = path.join(directory, SHARED_SETTINGS_MANIFEST_FILE_NAME);
    const future = {
      ...createProjection(),
      schemaVersion: 2,
      revision: 99,
      updatedAt: new Date().toISOString(),
      writerInstanceId: 'future-plugin',
      futureField: 'must survive',
    };
    const content = `${JSON.stringify(future, null, 2)}\n`;
    await writeFile(manifestPath, content, 'utf8');

    await expect(store.read()).rejects.toBeInstanceOf(UnsupportedSharedSettingsVersionError);
    await expect(
      store.patch({ kind: 'set-enabled', enabled: false }, 'old-plugin'),
    ).rejects.toBeInstanceOf(UnsupportedSharedSettingsVersionError);
    await expect(readFile(manifestPath, 'utf8')).resolves.toBe(content);
  });

  it('retains the complete old manifest and cleans lock and staging files after write interruption', async () => {
    const { directory, store: healthyStore } = await createStore();
    await healthyStore.initialize(createProjection(), 'initializer');
    const oldContent = await readFile(path.join(directory, SHARED_SETTINGS_MANIFEST_FILE_NAME), 'utf8');
    const interruptedStore = new SharedSettingsStore(directory, {
      publishStagedFile: async () => {
        throw new Error('simulated publication interruption');
      },
    });

    await expect(
      interruptedStore.patch({ kind: 'set-enabled', enabled: false }, 'interrupted-writer'),
    ).rejects.toThrow('simulated publication interruption');

    await expect(readFile(path.join(directory, SHARED_SETTINGS_MANIFEST_FILE_NAME), 'utf8')).resolves.toBe(oldContent);
    const names = await readdir(directory);
    expect(names).toEqual([SHARED_SETTINGS_MANIFEST_FILE_NAME]);
    await expect(healthyStore.read()).resolves.toMatchObject({ revision: 1, enabled: true });
  });
});
