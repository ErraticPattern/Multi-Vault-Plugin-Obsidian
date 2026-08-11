import { afterEach, describe, expect, it } from 'vitest';
import { fork, type ChildProcess } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises';
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
  SharedSettingsCommittedWithLockReleaseError,
  SharedSettingsLockCompromisedError,
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

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

async function waitForChildMessage(child: ChildProcess, expected: unknown): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for child message ${String(expected)}.`)), 5_000);
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('message', (message) => {
      if (message === expected) {
        clearTimeout(timer);
        resolve();
      }
    });
  });
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

  it('preserves unknown fields while upsert replaces every known vault field', async () => {
    const { directory, store } = await createStore();
    await store.initialize(createProjection(), 'initializer');

    const raw = await readRawManifest(directory);
    (raw.vaults as Array<Record<string, unknown>>)[0].futureVaultField = { retained: true };
    await writeFile(
      path.join(directory, SHARED_SETTINGS_MANIFEST_FILE_NAME),
      `${JSON.stringify(raw, null, 2)}\n`,
      'utf8',
    );

    await store.patch({
      kind: 'upsert-vault',
      vault: {
        id: 'ideas',
        pathKey: 'd:/moved/ideas',
        path: 'D:/Moved/Ideas',
        name: 'Moved Ideas',
        icon: 'lightbulb',
        enabled: false,
        includePatterns: ['Current'],
      },
    }, 'writer');

    const savedVault = (await readRawManifest(directory)).vaults as Array<Record<string, unknown>>;
    expect(savedVault[0]).toEqual({
      id: 'ideas',
      pathKey: 'd:/moved/ideas',
      path: 'D:/Moved/Ideas',
      name: 'Moved Ideas',
      icon: 'lightbulb',
      enabled: false,
      includePatterns: ['Current'],
      futureVaultField: { retained: true },
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

  it('uses randomized bounded sleeps against a strict wall-clock acquisition deadline', async () => {
    const { directory, store: healthyStore } = await createStore();
    await healthyStore.initialize(createProjection(), 'initializer');
    await mkdir(path.join(directory, SHARED_SETTINGS_LOCK_FILE_NAME));

    let clock = 10_000;
    const sleeps: number[] = [];
    const store = new SharedSettingsStore(directory, {
      lockTimeoutMs: 2_000,
      retryMinMs: 40,
      retryMaxMs: 100,
      lockNow: () => clock,
      random: () => 0.5,
      sleep: async (milliseconds) => {
        sleeps.push(milliseconds);
        clock += milliseconds;
      },
    });

    await expect(
      store.patch({ kind: 'set-enabled', enabled: false }, 'blocked-writer'),
    ).rejects.toBeInstanceOf(SharedSettingsLockTimeoutError);

    expect(clock).toBe(12_000);
    expect(sleeps.length).toBeGreaterThan(1);
    expect(sleeps.slice(0, -1).every((milliseconds) => milliseconds === 70)).toBe(true);
    expect(sleeps.at(-1)).toBeGreaterThan(0);
    expect(sleeps.at(-1)).toBeLessThanOrEqual(70);
  });

  it('keeps promise serialization within one store', async () => {
    const { store } = await createStore();
    await store.initialize(createProjection(), 'initializer');

    const results = await Promise.all([
      store.patch({ kind: 'set-enabled', enabled: false }, 'writer-a'),
      store.patch({ kind: 'set-enabled', enabled: true }, 'writer-b'),
    ]);

    expect(results.map((result) => result.revision)).toEqual([2, 3]);
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

  it('rejects unknown runtime patch discriminants without rewriting', async () => {
    const { directory, store } = await createStore();
    await store.initialize(createProjection(), 'initializer');
    const manifestPath = path.join(directory, SHARED_SETTINGS_MANIFEST_FILE_NAME);
    const original = await readFile(manifestPath, 'utf8');
    const unknownPatch = {
      ...await store.read(),
      kind: 'replace-manifest',
      enabled: false,
    } as unknown as SharedSettingsPatch;

    await expect(store.patch(unknownPatch, 'untrusted-caller')).rejects.toBeInstanceOf(
      InvalidSharedSettingsError,
    );
    await expect(readFile(manifestPath, 'utf8')).resolves.toBe(original);
  });

  it('times out after bounded retry while a live lock exists', async () => {
    const { directory, store } = await createStore({
      lockTimeoutMs: 80,
      retryMinMs: 5,
      retryMaxMs: 10,
    });
    await store.initialize(createProjection(), 'initializer');
    const lockPath = path.join(directory, SHARED_SETTINGS_LOCK_FILE_NAME);
    await mkdir(lockPath);

    const startedAt = Date.now();
    await expect(
      store.patch({ kind: 'set-enabled', enabled: false }, 'blocked-writer'),
    ).rejects.toBeInstanceOf(SharedSettingsLockTimeoutError);
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(60);
    expect(Date.now() - startedAt).toBeLessThan(1_000);
    await expect(stat(lockPath)).resolves.toBeDefined();
  });

  it('rechecks and expires a lock older than thirty seconds', async () => {
    const { directory, store } = await createStore({ retryMinMs: 1, retryMaxMs: 2 });
    await store.initialize(createProjection(), 'initializer');
    const lockPath = path.join(directory, SHARED_SETTINGS_LOCK_FILE_NAME);
    await mkdir(lockPath);
    const oldTime = new Date(Date.now() - 31_000);
    await utimes(lockPath, oldTime, oldTime);

    const saved = await store.patch({ kind: 'set-enabled', enabled: false }, 'new-owner');

    expect(saved).toMatchObject({ revision: 2, enabled: false, writerInstanceId: 'new-owner' });
    await expect(stat(lockPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('keeps an active heartbeat lease beyond the stale threshold', async () => {
    const enteredPublisher = deferred();
    const releasePublisher = deferred();
    const { directory, store: healthyStore } = await createStore();
    await healthyStore.initialize(createProjection(), 'initializer');
    const holder = new SharedSettingsStore(directory, {
      staleLockMs: 2_000,
      lockUpdateMs: 1_000,
      beforePublishStagedFile: async () => {
        enteredPublisher.resolve();
        await releasePublisher.promise;
      },
    });

    const heldPatch = holder.patch({ kind: 'set-enabled', enabled: false }, 'holder');
    await enteredPublisher.promise;
    const lockPath = path.join(directory, SHARED_SETTINGS_LOCK_FILE_NAME);
    const initialMtime = (await stat(lockPath)).mtimeMs;
    await new Promise((resolve) => setTimeout(resolve, 2_300));
    expect((await stat(lockPath)).mtimeMs).toBeGreaterThan(initialMtime);

    const contender = new SharedSettingsStore(directory, {
      lockTimeoutMs: 80,
      staleLockMs: 2_000,
      lockUpdateMs: 1_000,
      retryMinMs: 5,
      retryMaxMs: 10,
    });
    await expect(
      contender.patch({ kind: 'set-enabled', enabled: true }, 'contender'),
    ).rejects.toBeInstanceOf(SharedSettingsLockTimeoutError);

    releasePublisher.resolve();
    await expect(heldPatch).resolves.toMatchObject({ revision: 2, enabled: false });
  }, 10_000);

  it('rejects immediate prepublication replacement before heartbeat and preserves the replacement lock', async () => {
    const enteredPublisher = deferred();
    const releasePublisher = deferred();
    let compromiseCount = 0;
    const { directory, store: healthyStore } = await createStore();
    await healthyStore.initialize(createProjection(), 'initializer');
    const store = new SharedSettingsStore(directory, {
      staleLockMs: 30_000,
      lockUpdateMs: 5_000,
      beforePublishStagedFile: async () => {
        enteredPublisher.resolve();
        await releasePublisher.promise;
      },
      onLockCompromised: () => {
        compromiseCount += 1;
      },
    });
    const manifestPath = path.join(directory, SHARED_SETTINGS_MANIFEST_FILE_NAME);
    const oldContent = await readFile(manifestPath, 'utf8');

    const patch = store.patch({ kind: 'set-enabled', enabled: false }, 'compromised-writer');
    await enteredPublisher.promise;
    const lockPath = path.join(directory, SHARED_SETTINGS_LOCK_FILE_NAME);
    await rm(lockPath, { recursive: true });
    await mkdir(lockPath);
    const replacementStat = await stat(lockPath, { bigint: true });
    const replacementIdentity = { dev: replacementStat.dev, ino: replacementStat.ino };

    // Resume immediately, well before the old owner's five-second heartbeat can detect replacement.
    releasePublisher.resolve();

    await expect(patch).rejects.toBeInstanceOf(SharedSettingsLockCompromisedError);
    await expect(readFile(manifestPath, 'utf8')).resolves.toBe(oldContent);
    const survivingReplacement = await stat(lockPath, { bigint: true });
    expect({ dev: survivingReplacement.dev, ino: survivingReplacement.ino }).toEqual(replacementIdentity);
    expect(compromiseCount).toBe(1);
  }, 10_000);

  it('guards release identity and never removes a postpublication replacement lock', async () => {
    const { directory, store: healthyStore } = await createStore();
    await healthyStore.initialize(createProjection(), 'initializer');
    const lockPath = path.join(directory, SHARED_SETTINGS_LOCK_FILE_NAME);
    let replacementIdentity: { dev: bigint; ino: bigint } | undefined;
    const store = new SharedSettingsStore(directory, {
      releaseLock: async (release) => {
        await rm(lockPath, { recursive: true });
        await mkdir(lockPath);
        const replacementStat = await stat(lockPath, { bigint: true });
        replacementIdentity = { dev: replacementStat.dev, ino: replacementStat.ino };
        await release();
      },
    });

    let caught: unknown;
    try {
      await store.patch({ kind: 'set-enabled', enabled: false }, 'published-writer');
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(SharedSettingsCommittedWithLockReleaseError);
    expect(caught).toMatchObject({ cause: expect.any(SharedSettingsLockCompromisedError) });
    await expect(healthyStore.read()).resolves.toMatchObject({ revision: 2, enabled: false });
    const survivingReplacement = await stat(lockPath, { bigint: true });
    expect({ dev: survivingReplacement.dev, ino: survivingReplacement.ino }).toEqual(replacementIdentity);
  });

  it('contends with a real proper-lockfile owner in a child process', async () => {
    const { directory, store } = await createStore({
      lockTimeoutMs: 80,
      retryMinMs: 5,
      retryMaxMs: 10,
    });
    await store.initialize(createProjection(), 'initializer');
    const child = fork(
      path.join(process.cwd(), 'tests', 'fixtures', 'proper-lockfile-holder.cjs'),
      [path.join(directory, SHARED_SETTINGS_MANIFEST_FILE_NAME)],
      { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] },
    );

    try {
      await waitForChildMessage(child, 'locked');
      await expect(
        store.patch({ kind: 'set-enabled', enabled: false }, 'parent'),
      ).rejects.toBeInstanceOf(SharedSettingsLockTimeoutError);
      await expect(store.read()).resolves.toMatchObject({ revision: 1, enabled: true });
      child.send('release');
      await new Promise<void>((resolve, reject) => {
        child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`Child exited with ${code}.`)));
      });
    } finally {
      if (!child.killed && child.exitCode === null) child.kill();
    }
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

  it('preserves a primary operation error when release also fails', async () => {
    const primaryError = new Error('publication failed first');
    const releaseError = new Error('release failed second');
    const { directory, store: healthyStore } = await createStore();
    await healthyStore.initialize(createProjection(), 'initializer');
    const original = await readFile(path.join(directory, SHARED_SETTINGS_MANIFEST_FILE_NAME), 'utf8');
    const failingStore = new SharedSettingsStore(directory, {
      releaseLock: async (release) => {
        await release();
        throw releaseError;
      },
      publishStagedFile: async () => {
        throw primaryError;
      },
    });

    await expect(
      failingStore.patch({ kind: 'set-enabled', enabled: false }, 'writer'),
    ).rejects.toBe(primaryError);
    await expect(readFile(path.join(directory, SHARED_SETTINGS_MANIFEST_FILE_NAME), 'utf8')).resolves.toBe(original);
  });

  it('reports a committed publication with release failure as unsafe to retry', async () => {
    const releaseError = new Error('release failed after commit');
    const { directory, store: healthyStore } = await createStore();
    await healthyStore.initialize(createProjection(), 'initializer');
    const failingStore = new SharedSettingsStore(directory, {
      releaseLock: async (release) => {
        await release();
        throw releaseError;
      },
    });

    let caught: unknown;
    try {
      await failingStore.patch({ kind: 'set-enabled', enabled: false }, 'writer');
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(SharedSettingsCommittedWithLockReleaseError);
    expect(caught).toMatchObject({
      cause: releaseError,
      committedManifest: { revision: 2, enabled: false, writerInstanceId: 'writer' },
    });
    expect((caught as Error).message).toContain('must not be retried blindly');
    await expect(healthyStore.read()).resolves.toMatchObject({ revision: 2, enabled: false });
  });

  it('publishes complete old-or-new JSON while readers span the blocked atomic rename', async () => {
    const enteredPublisher = deferred();
    const releasePublisher = deferred();
    const { directory, store: healthyStore } = await createStore();
    await healthyStore.initialize(createProjection(), 'initializer');
    const store = new SharedSettingsStore(directory, {
      beforePublishStagedFile: async () => {
        enteredPublisher.resolve();
        await releasePublisher.promise;
      },
    });
    const manifestPath = path.join(directory, SHARED_SETTINGS_MANIFEST_FILE_NAME);
    const observed: Array<Record<string, unknown>> = [];
    const publication = store.patch({ kind: 'set-enabled', enabled: false }, 'publisher');
    await enteredPublisher.promise;

    const readersStarted = deferred();
    let startedReaderCount = 0;
    const readerCount = 2;
    const readers = Array.from({ length: readerCount }, async () => {
      let firstRead = true;
      while (true) {
        try {
          const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, unknown>;
          observed.push(manifest);
          if (firstRead) {
            firstRead = false;
            startedReaderCount += 1;
            if (startedReaderCount === readerCount) readersStarted.resolve();
          }
          if (manifest.revision === 2) return;
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code !== 'EACCES' && code !== 'EPERM' && code !== 'ENOENT') throw error;
        }
        // Leave Windows a sharing-free interval in which rename can complete.
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    });
    await readersStarted.promise;
    expect(observed.some((manifest) => manifest.revision === 1)).toBe(true);

    releasePublisher.resolve();
    await publication;
    await Promise.all(readers);

    expect(observed.some((manifest) => manifest.revision === 2)).toBe(true);
    for (const manifest of observed) {
      expect([1, 2]).toContain(manifest.revision);
      expect(manifest.schemaVersion).toBe(1);
      expect(manifest.enabled).toBe(manifest.revision === 1);
      expect(Array.isArray(manifest.vaults)).toBe(true);
      expect(manifest.virtualLinks).toBeTypeOf('object');
    }
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
