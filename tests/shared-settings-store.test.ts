import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  SHARED_SETTINGS_DIRECTORY_NAME,
  SHARED_SETTINGS_PATCH_DIRECTORY_NAME,
  SHARED_SETTINGS_SEED_FILE_NAME,
  SharedSettingsStore,
  type SharedSettingsPatch,
  type SharedSettingsPatchEnvelope,
} from '../src/shared-settings/shared-settings-store';
import {
  InvalidSharedSettingsError,
  MalformedSharedSettingsError,
  SharedSettingsInitializationConflictError,
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
): Promise<{ root: string; store: SharedSettingsStore }> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mvn-shared-store-'));
  tempDirs.push(root);
  return { root, store: new SharedSettingsStore(root, options) };
}

function journalPath(root: string): string {
  return path.join(root, SHARED_SETTINGS_DIRECTORY_NAME);
}

function seedPath(root: string): string {
  return path.join(journalPath(root), SHARED_SETTINGS_SEED_FILE_NAME);
}

function patchesPath(root: string): string {
  return path.join(journalPath(root), SHARED_SETTINGS_PATCH_DIRECTORY_NAME);
}

async function patchFiles(root: string): Promise<string[]> {
  return (await readdir(patchesPath(root))).filter((name) => name.endsWith('.json')).sort();
}

function manualEnvelope(
  id: string,
  patch: SharedSettingsPatch,
  overrides: Partial<SharedSettingsPatchEnvelope> = {},
): SharedSettingsPatchEnvelope {
  return {
    schemaVersion: 1,
    id,
    writerInstanceId: 'manual-writer',
    logicalClock: 1,
    createdAt: '2026-08-10T12:00:00.000Z',
    patch,
    ...overrides,
  };
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('SharedSettingsStore immutable patch journal', () => {
  it('stores an exclusively initialized revision-zero seed under the application-data root', async () => {
    const { root, store } = await createStore();

    await expect(store.read()).resolves.toBeNull();
    const initialized = await store.initialize(createProjection(), 'ideas-instance');

    expect(initialized).toMatchObject({
      schemaVersion: 2,
      revision: 0,
      writerInstanceId: 'ideas-instance',
      enabled: true,
    });
    expect(Number.isNaN(Date.parse(initialized.updatedAt))).toBe(false);
    await expect(store.read()).resolves.toEqual(initialized);
    expect((await stat(seedPath(root))).isFile()).toBe(true);
    await expect(readdir(patchesPath(root))).resolves.toEqual([]);
    await expect(readdir(root)).resolves.toEqual([SHARED_SETTINGS_DIRECTORY_NAME]);
  });

  it('migrates a schema-1 seed to a path-free schema-2 manifest in memory', async () => {
    const { root, store } = await createStore();
    await mkdir(journalPath(root), { recursive: true });
    await writeFile(seedPath(root), JSON.stringify({
      ...createProjection(),
      schemaVersion: 1,
      revision: 0,
      updatedAt: '2026-08-10T12:00:00.000Z',
      writerInstanceId: 'legacy-writer',
    }), 'utf8');

    const migrated = await store.read();
    expect(migrated?.schemaVersion).toBe(2);
    expect(migrated?.vaults.every(vault => vault.path === undefined && vault.pathKey === undefined)).toBe(true);
  });

  it('folds every explicit patch and makes revision equal the patch count', async () => {
    const { root, store } = await createStore();
    await store.initialize(createProjection(), 'initializer');
    const originalSeed = await readFile(seedPath(root), 'utf8');

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
      expect(saved.revision).toBe(index + 1);
    }

    const saved = await store.read();
    expect(saved).toMatchObject({
      revision: patches.length,
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
    expect(await patchFiles(root)).toHaveLength(patches.length);
    await expect(readFile(seedPath(root), 'utf8')).resolves.toBe(originalSeed);
  });

  it('preserves unknown seed, extension, and record fields through folding and upsert', async () => {
    const { store } = await createStore();
    const projection = createProjection() as SharedSettingsProjection & Record<string, unknown>;
    projection.extensions = { thirdParty: { version: 2, values: ['kept'] } };
    projection.futureTopLevelField = { enabled: true };
    (projection.vaults[0] as typeof projection.vaults[number] & Record<string, unknown>).futureVaultField = {
      retained: true,
    };
    await store.initialize(projection, 'initializer');

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

    const saved = await store.read() as unknown as typeof projection & { revision: number };
    expect(saved.extensions).toEqual({ thirdParty: { version: 2, values: ['kept'] } });
    expect(saved.futureTopLevelField).toEqual({ enabled: true });
    expect(saved.vaults[0]).toEqual({
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

  it('preserves disjoint concurrent edits from independent writers', async () => {
    const { root, store: storeA } = await createStore();
    const storeB = new SharedSettingsStore(root);
    await storeA.initialize(createProjection(), 'initializer');

    await Promise.all([
      storeA.patch({ kind: 'set-vault-color', vaultId: 'ideas', color: '#112233' }, 'writer-a'),
      storeB.patch({ kind: 'set-vault-icon', vaultId: 'ideas', icon: 'brain' }, 'writer-b'),
    ]);

    const saved = await storeA.read();
    expect(saved?.vaults[0]).toMatchObject({ color: '#112233', icon: 'brain' });
    expect(saved?.revision).toBe(2);
    expect(await patchFiles(root)).toHaveLength(2);
  });

  it('orders observed dependent patches by logical clock despite wall-clock rollback', async () => {
    const times = [
      new Date('2026-08-10T12:00:00.000Z'),
      new Date('2026-08-10T13:00:00.000Z'),
      new Date('2026-08-10T11:00:00.000Z'),
    ];
    const { root, store } = await createStore({ now: () => times.shift()! });
    await store.initialize(createProjection(), 'initializer');

    await store.patch({
      kind: 'upsert-vault',
      vault: {
        id: 'research',
        pathKey: 'c:/vaults/research',
        path: 'C:/Vaults/Research',
        name: 'Research',
        enabled: true,
      },
    }, 'upsert-writer');
    await store.patch({ kind: 'set-vault-color', vaultId: 'research', color: '#123456' }, 'color-writer');

    const files = await patchFiles(root);
    const envelopes = await Promise.all(files.map(async (fileName) => (
      JSON.parse(await readFile(path.join(patchesPath(root), fileName), 'utf8')) as SharedSettingsPatchEnvelope
    )));
    expect(envelopes.map((envelope) => envelope.logicalClock).sort((a, b) => a - b)).toEqual([1, 2]);
    expect(envelopes.find((envelope) => envelope.patch.kind === 'set-vault-color')?.createdAt)
      .toBe('2026-08-10T11:00:00.000Z');
    await expect(store.read()).resolves.toMatchObject({
      revision: 2,
      vaults: expect.arrayContaining([expect.objectContaining({ id: 'research', color: '#123456' })]),
    });
  });

  it('keeps concurrent remove and vault edits total in both deterministic orderings', async () => {
    const cases = [
      { removeWriter: 'remove-last', setWriter: 'set-last', expectedFirstKind: 'remove-vault' },
      { removeWriter: 'remove-first', setWriter: 'set-first', expectedFirstKind: 'set-vault-color' },
    ] as const;

    for (const race of cases) {
      const bothReady = deferred();
      const release = deferred();
      let readyCount = 0;
      const beforePublishPatch = async () => {
        readyCount += 1;
        if (readyCount === 2) bothReady.resolve();
        await release.promise;
      };
      const { root, store: storeA } = await createStore({ beforePublishPatch });
      const storeB = new SharedSettingsStore(root, { beforePublishPatch });
      await storeA.initialize(createProjection(), 'initializer');

      const removal = storeA.patch({ kind: 'remove-vault', vaultId: 'medicine' }, race.removeWriter);
      const edit = storeB.patch(
        { kind: 'set-vault-color', vaultId: 'medicine', color: '#123456' },
        race.setWriter,
      );
      await bothReady.promise;
      release.resolve();
      await Promise.all([removal, edit]);

      const concurrentFiles = await patchFiles(root);
      const concurrentEnvelopes = await Promise.all(concurrentFiles.map(async (fileName) => (
        JSON.parse(await readFile(path.join(patchesPath(root), fileName), 'utf8')) as SharedSettingsPatchEnvelope
      )));
      concurrentEnvelopes.sort((left, right) => (
        left.logicalClock - right.logicalClock || left.id.localeCompare(right.id)
      ));
      expect(concurrentEnvelopes.map((envelope) => envelope.logicalClock)).toEqual([1, 1]);
      expect(concurrentEnvelopes[0].patch.kind).toBe(race.expectedFirstKind);
      await expect(storeA.read()).resolves.toMatchObject({ revision: 2 });
      expect((await storeA.read())?.vaults.some((vault) => vault.id === 'medicine')).toBe(false);

      await storeA.patch({ kind: 'set-enabled', enabled: false }, 'recovery-writer');
      await expect(storeB.read()).resolves.toMatchObject({ revision: 3, enabled: false });
      expect(await patchFiles(root)).toHaveLength(3);
    }
  });

  it('treats patches referencing concurrently removed vaults as no-ops or filtered integrations', async () => {
    const { store } = await createStore();
    await store.initialize(createProjection(), 'initializer');
    await store.patch({ kind: 'remove-vault', vaultId: 'medicine' }, 'remover');

    const missingVaultPatches: SharedSettingsPatch[] = [
      { kind: 'remove-vault', vaultId: 'medicine' },
      { kind: 'set-vault-excluded', vaultId: 'medicine', excluded: true },
      { kind: 'set-vault-color', vaultId: 'medicine', color: '#123456' },
      { kind: 'set-vault-icon', vaultId: 'medicine', icon: 'pill' },
      { kind: 'set-vault-enabled', vaultId: 'medicine', enabled: false },
      { kind: 'set-vault-patterns', vaultId: 'medicine', include: ['Notes'], exclude: [] },
      { kind: 'set-virtual-link-source-excluded', vaultId: 'medicine', excluded: true },
      { kind: 'set-virtual-link-targets', sourceVaultId: 'medicine', targetVaultIds: ['ideas'] },
      { kind: 'set-virtual-link-targets', sourceVaultId: 'ideas', targetVaultIds: ['medicine'] },
    ];
    for (const patch of missingVaultPatches) await store.patch(patch, 'concurrent-peer');

    await expect(store.read()).resolves.toMatchObject({
      revision: missingVaultPatches.length + 1,
      excludedVaultIds: [],
      virtualLinks: {
        excludedSourceVaultIds: [],
        targetVaultIdsBySource: { ideas: [] },
      },
    });
  });

  it('resolves same-field concurrent edits deterministically by logical clock and ID', async () => {
    const fixedNow = () => new Date('2026-08-10T12:00:00.000Z');
    const { root, store: storeA } = await createStore({ now: fixedNow });
    const storeB = new SharedSettingsStore(root, { now: fixedNow });
    await storeA.initialize(createProjection(), 'initializer');

    await Promise.all([
      storeA.patch({ kind: 'set-vault-color', vaultId: 'ideas', color: '#111111' }, 'writer-a'),
      storeB.patch({ kind: 'set-vault-color', vaultId: 'ideas', color: '#222222' }, 'writer-b'),
    ]);

    const files = await patchFiles(root);
    const lastEnvelope = JSON.parse(
      await readFile(path.join(patchesPath(root), files.at(-1)!), 'utf8'),
    ) as SharedSettingsPatchEnvelope;
    const expectedColor = (lastEnvelope.patch as Extract<SharedSettingsPatch, { kind: 'set-vault-color' }>).color;
    const result = await storeA.read();
    expect(result?.revision).toBe(2);
    expect(result?.vaults[0].color).toBe(expectedColor);
    await expect(storeB.read()).resolves.toEqual(result);
  });

  it('publishes zero-lost concurrent patches from many independent writers', async () => {
    const { root, store } = await createStore();
    await store.initialize(createProjection(), 'initializer');
    const writerCount = 100;

    await Promise.all(Array.from({ length: writerCount }, (_, index) => (
      new SharedSettingsStore(root).patch(
        { kind: 'set-enabled', enabled: index % 2 === 0 },
        `writer-${index}`,
      )
    )));

    expect(await patchFiles(root)).toHaveLength(writerCount);
    await expect(store.read()).resolves.toMatchObject({ revision: writerCount });
  });

  it('rejects conflicting concurrent seed initialization but returns the same published seed to equal losers', async () => {
    const { root, store: storeA } = await createStore();
    const storeB = new SharedSettingsStore(root);
    const [first, second] = await Promise.all([
      storeA.initialize(createProjection(), 'writer-a'),
      storeB.initialize(createProjection(), 'writer-b'),
    ]);
    expect(first).toEqual(second);
    expect(first.revision).toBe(0);

    const conflictRoot = await mkdtemp(path.join(os.tmpdir(), 'mvn-shared-store-'));
    tempDirs.push(conflictRoot);
    const projectionA = createProjection();
    const projectionB = { ...createProjection(), enabled: false };
    const results = await Promise.allSettled([
      new SharedSettingsStore(conflictRoot).initialize(projectionA, 'writer-a'),
      new SharedSettingsStore(conflictRoot).initialize(projectionB, 'writer-b'),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((result) => result.status === 'rejected') as PromiseRejectedResult;
    expect(rejected.reason).toBeInstanceOf(SharedSettingsInitializationConflictError);
    await expect(new SharedSettingsStore(conflictRoot).read()).resolves.toMatchObject({ revision: 0 });
    await expect(readdir(journalPath(conflictRoot))).resolves.not.toEqual(
      expect.arrayContaining([expect.stringMatching(/^\.pending-/)]),
    );
  });

  it('ignores complete and partial pending files', async () => {
    const { root, store } = await createStore();
    await store.initialize(createProjection(), 'initializer');
    await writeFile(path.join(patchesPath(root), '.pending-crash'), '{ partial', 'utf8');
    await writeFile(
      path.join(patchesPath(root), '.pending-complete.json'),
      JSON.stringify({ schemaVersion: 99, destructive: true }),
      'utf8',
    );

    await expect(store.read()).resolves.toMatchObject({ revision: 0, enabled: true });
  });

  it('cleans its pending file and leaves the journal unchanged after an interrupted write', async () => {
    const interruption = new Error('simulated publication interruption');
    const { root, store: healthyStore } = await createStore();
    await healthyStore.initialize(createProjection(), 'initializer');
    const interruptedStore = new SharedSettingsStore(root, {
      beforePublishPatch: async () => {
        throw interruption;
      },
    });

    await expect(
      interruptedStore.patch({ kind: 'set-enabled', enabled: false }, 'interrupted-writer'),
    ).rejects.toBe(interruption);

    await expect(patchFiles(root)).resolves.toEqual([]);
    expect((await readdir(patchesPath(root))).filter((name) => name.startsWith('.pending-'))).toEqual([]);
    await expect(healthyStore.read()).resolves.toMatchObject({ revision: 0, enabled: true });
  });

  it('lets readers observe only complete journal states across publication', async () => {
    const enteredPublisher = deferred();
    const releasePublisher = deferred();
    const { root, store: reader } = await createStore();
    await reader.initialize(createProjection(), 'initializer');
    const publisher = new SharedSettingsStore(root, {
      beforePublishPatch: async () => {
        enteredPublisher.resolve();
        await releasePublisher.promise;
      },
    });

    const publication = publisher.patch({ kind: 'set-enabled', enabled: false }, 'publisher');
    await enteredPublisher.promise;
    const observations = await Promise.all(Array.from({ length: 30 }, () => reader.read()));
    expect(observations.every((manifest) => manifest?.revision === 0 && manifest.enabled)).toBe(true);

    releasePublisher.resolve();
    await publication;
    const completed = await Promise.all(Array.from({ length: 30 }, () => reader.read()));
    expect(completed.every((manifest) => manifest?.revision === 1 && !manifest.enabled)).toBe(true);
  });

  it('rejects malformed and future patch envelopes without resetting state', async () => {
    const malformedStore = await createStore();
    await malformedStore.store.initialize(createProjection(), 'initializer');
    const malformedId = '0001754827200000-1111111111111111-000000000001-11111111111111111111111111111111';
    const malformedPath = path.join(patchesPath(malformedStore.root), `${malformedId}.json`);
    await writeFile(malformedPath, '{ definitely not JSON', 'utf8');

    let malformedError: unknown;
    try {
      await malformedStore.store.read();
    } catch (error) {
      malformedError = error;
    }
    expect(malformedError).toBeInstanceOf(MalformedSharedSettingsError);
    expect((malformedError as Error).message.length).toBeLessThan(300);
    await expect(readFile(malformedPath, 'utf8')).resolves.toBe('{ definitely not JSON');

    const futureStore = await createStore();
    await futureStore.store.initialize(createProjection(), 'initializer');
    const futureId = '0001754827200000-2222222222222222-000000000001-22222222222222222222222222222222';
    const future = {
      ...manualEnvelope(futureId, { kind: 'set-enabled', enabled: false }),
      schemaVersion: 3,
    };
    const futureContent = `${JSON.stringify(future)}\n`;
    const futurePath = path.join(patchesPath(futureStore.root), `${futureId}.json`);
    await writeFile(futurePath, futureContent, 'utf8');

    await expect(futureStore.store.read()).rejects.toBeInstanceOf(UnsupportedSharedSettingsVersionError);
    await expect(
      futureStore.store.patch({ kind: 'set-enabled', enabled: true }, 'old-writer'),
    ).rejects.toBeInstanceOf(UnsupportedSharedSettingsVersionError);
    await expect(readFile(futurePath, 'utf8')).resolves.toBe(futureContent);
    await expect(readFile(seedPath(futureStore.root), 'utf8')).resolves.toContain('"revision": 0');
  });

  it('validates envelope identity, explicit patch shape, and each folded result', async () => {
    const { root, store } = await createStore();
    await store.initialize(createProjection(), 'initializer');
    const id = '0001754827200000-3333333333333333-000000000001-33333333333333333333333333333333';
    await writeFile(
      path.join(patchesPath(root), `${id}.json`),
      JSON.stringify(manualEnvelope(id, {
        kind: 'upsert-vault',
        vault: {
          id: 'duplicate-path',
          pathKey: 'c:/vaults/ideas',
          path: 'C:/Vaults/Ideas',
          name: '',
          enabled: true,
        },
      })),
      'utf8',
    );

    await expect(store.read()).rejects.toBeInstanceOf(InvalidSharedSettingsError);

    const mismatchStore = await createStore();
    await mismatchStore.store.initialize(createProjection(), 'initializer');
    const fileId = '0001754827200000-4444444444444444-000000000001-44444444444444444444444444444444';
    const envelopeId = '0001754827200000-5555555555555555-000000000001-55555555555555555555555555555555';
    await writeFile(
      path.join(patchesPath(mismatchStore.root), `${fileId}.json`),
      JSON.stringify(manualEnvelope(envelopeId, { kind: 'set-enabled', enabled: false })),
      'utf8',
    );
    await expect(mismatchStore.store.read()).rejects.toBeInstanceOf(InvalidSharedSettingsError);
  });

  it('rejects unknown or non-explicit runtime patches before writing', async () => {
    const { root, store } = await createStore();
    await store.initialize(createProjection(), 'initializer');
    const unknownPatch = {
      ...await store.read(),
      kind: 'replace-manifest',
      enabled: false,
    } as unknown as SharedSettingsPatch;
    const extraFieldPatch = {
      kind: 'set-enabled',
      enabled: false,
      replacementManifest: createProjection(),
    } as unknown as SharedSettingsPatch;

    await expect(store.patch(unknownPatch, 'untrusted')).rejects.toBeInstanceOf(InvalidSharedSettingsError);
    await expect(store.patch(extraFieldPatch, 'untrusted')).rejects.toBeInstanceOf(InvalidSharedSettingsError);
    await expect(
      store.patch({ kind: 'set-vault-color', vaultId: 'ideas', color: 'red' }, 'untrusted'),
    ).rejects.toBeInstanceOf(InvalidSharedSettingsError);
    await expect(patchFiles(root)).resolves.toEqual([]);
    await expect(store.read()).resolves.toMatchObject({ revision: 0, enabled: true });
  });

  it('rejects malformed, invalid, and future seeds without replacing them', async () => {
    const malformed = await createStore();
    await mkdir(journalPath(malformed.root), { recursive: true });
    await writeFile(seedPath(malformed.root), '{ malformed', 'utf8');
    await expect(malformed.store.read()).rejects.toBeInstanceOf(MalformedSharedSettingsError);

    const invalid = await createStore();
    await mkdir(journalPath(invalid.root), { recursive: true });
    const invalidSeed = {
      ...createProjection(),
      schemaVersion: 1,
      revision: 1,
      updatedAt: new Date().toISOString(),
      writerInstanceId: 'invalid',
    };
    await writeFile(seedPath(invalid.root), JSON.stringify(invalidSeed), 'utf8');
    await expect(invalid.store.read()).rejects.toBeInstanceOf(InvalidSharedSettingsError);

    const future = await createStore();
    await mkdir(journalPath(future.root), { recursive: true });
    const futureSeed = { ...invalidSeed, schemaVersion: 3, revision: 0, futureField: 'kept' };
    const futureContent = JSON.stringify(futureSeed);
    await writeFile(seedPath(future.root), futureContent, 'utf8');
    await expect(future.store.read()).rejects.toBeInstanceOf(UnsupportedSharedSettingsVersionError);
    await expect(readFile(seedPath(future.root), 'utf8')).resolves.toBe(futureContent);
  });
});
