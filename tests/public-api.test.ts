import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MultiVaultPublicApi } from '../src/api/multi-vault-public-api';
import type { MultiVaultApiEvent } from '../src/api/public-api-types';
import type { IndexedFile, MultiVaultSettings, VaultConfig } from '../src/types';

const vaults: VaultConfig[] = [
  { id: 'ideas', name: 'Ideas', path: 'C:/vaults/Ideas', enabled: true, color: '#fa0000' },
  { id: 'medicine', name: 'medicine', path: 'C:/vaults/Medicine', enabled: true, color: '#ac20df' },
  { id: 'hobbies', name: 'Hobbies', path: 'C:/vaults/Hobbies', enabled: true, color: '#1fe1e5' },
];

function indexed(
  vaultId: string,
  relativePath: string,
  overrides: Partial<IndexedFile> = {},
): IndexedFile {
  const vault = vaults.find((candidate) => candidate.id === vaultId)!;
  const filename = relativePath.split('/').pop()!;
  const dot = filename.lastIndexOf('.');
  return {
    id: `${vaultId}:${relativePath}`,
    vaultId,
    vaultName: vault.name,
    absolutePath: `${vault.path}/${relativePath}`,
    relativePath,
    basename: dot < 0 ? filename : filename.slice(0, dot),
    extension: dot < 0 ? '' : filename.slice(dot),
    mtime: 1,
    size: 1,
    ...overrides,
  };
}

const initialFiles: IndexedFile[] = [
  indexed('ideas', 'Local.md'),
  indexed('medicine', 'Notes/ZeroTier.md', {
    frontmatter: { aliases: [' ZT ', '', 'zt', 'Zero Tier'], secret: 'not projected' },
    contentPreview: 'private note text',
  }),
  indexed('medicine', 'README.md'),
  indexed('medicine', 'Archive/README.md'),
  indexed('medicine', 'Attachments/diagram.png'),
  indexed('hobbies', 'Projects/Radio.md'),
];

function makeSettings(): MultiVaultSettings {
  return {
    vaults: vaults.map((vault) => ({ ...vault })),
    indexOptions: {
      maxPreviewChars: 1_000,
      autoRefreshOnStartup: false,
      globalExcludePatterns: [],
      storeSnippetsInCache: true,
    },
    savedSearches: [],
    pinnedFiles: [],
    showCrossVaultBadge: true,
    useVaultColorForLinks: true,
    virtualLinks: {
      enabled: true,
      excludedSourceVaultIds: [],
      targetVaultIdsBySource: { ideas: ['medicine'] },
      colorMode: 'soft-pill',
      colorIntensity: 55,
    },
  };
}

function harness(platform: NodeJS.Platform = 'win32') {
  const settings = makeSettings();
  let files = [...initialFiles];
  let currentVaultId: string | null = 'ideas';
  const catalogListeners = new Set<() => void>();
  const indexer = {
    getIndexedFiles: () => files,
    onCatalogChanged: (listener: () => void) => {
      catalogListeners.add(listener);
      return () => catalogListeners.delete(listener);
    },
  };
  const registry = {
    getCurrentVaultId: () => currentVaultId,
    getVaultById: (vaultId: string) => settings.vaults.find((vault) => vault.id === vaultId),
  };
  const openFile = vi.fn(async () => undefined);
  const api = new MultiVaultPublicApi(settings, registry, indexer, { openFile }, platform);
  return {
    api,
    settings,
    openFile,
    setFiles(next: IndexedFile[]) { files = next; },
    setCurrentVaultId(vaultId: string | null) { currentVaultId = vaultId; },
    emitCatalogChanged() {
      for (const listener of catalogListeners) listener();
    },
  };
}

async function flushEvents(): Promise<void> {
  await Promise.resolve();
}

describe('MultiVault public API v1 contract', () => {
  let test: ReturnType<typeof harness>;

  beforeEach(() => {
    test = harness();
  });

  it('reports its version, effective integration settings, and current vault appearance', () => {
    expect(test.api.apiVersion).toBe(1);
    expect(test.api.getCurrentVault()).toEqual({
      vaultId: 'ideas', vaultName: 'Ideas', color: '#fa0000',
    });
    expect(test.api.getVirtualLinkSettings()).toEqual({
      enabled: true, colorMode: 'soft-pill', colorIntensity: 55,
    });
  });

  it('lists only opted-in external indexed Markdown targets without note content', () => {
    const targets = test.api.listVirtualLinkTargets();
    expect(targets).toEqual([
      {
        identity: { vaultId: 'medicine', relativePath: 'Notes/ZeroTier.md' },
        title: 'ZeroTier', aliases: ['ZT', 'Zero Tier'], vaultName: 'medicine', color: '#ac20df',
      },
      {
        identity: { vaultId: 'medicine', relativePath: 'README.md' },
        title: 'README', aliases: [], vaultName: 'medicine', color: '#ac20df',
      },
      {
        identity: { vaultId: 'medicine', relativePath: 'Archive/README.md' },
        title: 'README', aliases: [], vaultName: 'medicine', color: '#ac20df',
      },
    ]);
    expect(JSON.stringify(targets)).not.toContain('contentPreview');
    expect(JSON.stringify(targets)).not.toContain('private note text');
    expect(JSON.stringify(targets)).not.toContain('absolutePath');
    expect(JSON.stringify(targets)).not.toContain('frontmatter');
  });

  it('normalizes string aliases and rejects invalid colors at the boundary', () => {
    test.settings.vaults.find((vault) => vault.id === 'medicine')!.color = 'purple';
    test.setFiles([
      indexed('medicine', 'StringAlias.md', { frontmatter: { aliases: '  Alias  ' } }),
    ]);

    expect(test.api.listVirtualLinkTargets()).toEqual([{
      identity: { vaultId: 'medicine', relativePath: 'StringAlias.md' },
      title: 'StringAlias', aliases: ['Alias'], vaultName: 'medicine',
    }]);
  });

  it('returns an empty, disabled projection when integration is disabled or the source is missing/excluded', () => {
    test.settings.virtualLinks!.enabled = false;
    expect(test.api.listVirtualLinkTargets()).toEqual([]);
    expect(test.api.getVirtualLinkSettings().enabled).toBe(false);
    expect(test.api.resolveTarget({ vaultName: 'medicine', noteRef: 'ZeroTier' }))
      .toEqual({ kind: 'missing' });

    test.settings.virtualLinks!.enabled = true;
    test.settings.virtualLinks!.excludedSourceVaultIds = ['ideas'];
    expect(test.api.listVirtualLinkTargets()).toEqual([]);
    expect(test.api.getVirtualLinkSettings().enabled).toBe(false);

    test.settings.virtualLinks!.excludedSourceVaultIds = [];
    test.setCurrentVaultId(null);
    expect(test.api.getCurrentVault()).toBeNull();
    expect(test.api.listVirtualLinkTargets()).toEqual([]);
    expect(test.api.getVirtualLinkSettings().enabled).toBe(false);
  });

  it('resolves unique paths and preserves every duplicate candidate instead of choosing the first', () => {
    expect(test.api.resolveTarget({ vaultName: 'medicine', noteRef: 'zerotier' })).toEqual({
      kind: 'resolved',
      target: expect.objectContaining({
        identity: { vaultId: 'medicine', relativePath: 'Notes/ZeroTier.md' },
      }),
    });
    expect(test.api.resolveTarget({ vaultName: 'medicine', noteRef: '/README' })).toEqual({
      kind: 'resolved',
      target: expect.objectContaining({
        identity: { vaultId: 'medicine', relativePath: 'README.md' },
      }),
    });
    expect(test.api.resolveTarget({ vaultName: 'medicine', noteRef: 'README' })).toEqual({
      kind: 'ambiguous',
      candidates: [
        expect.objectContaining({
          identity: { vaultId: 'medicine', relativePath: 'Archive/README.md' },
        }),
        expect.objectContaining({
          identity: { vaultId: 'medicine', relativePath: 'README.md' },
        }),
      ],
    });
    expect(test.api.resolveTarget({ vaultName: 'medicine', noteRef: 'Absent' }))
      .toEqual({ kind: 'missing' });
  });

  it('formats unique, path-qualified, and explicit-root canonical wikilinks', () => {
    expect(test.api.formatWikilink({ vaultId: 'medicine', relativePath: 'Notes/ZeroTier.md' }))
      .toBe('[[ZeroTier@medicine]]');
    expect(test.api.formatWikilink(
      { vaultId: 'medicine', relativePath: 'Archive/README.md' },
      'Read me',
    )).toBe('[[Archive/README@medicine|Read me]]');
    expect(test.api.formatWikilink({ vaultId: 'medicine', relativePath: 'README.md' }))
      .toBe('[[/README@medicine]]');
  });

  it('opens only the exact canonical indexed target', async () => {
    await test.api.openTarget({ vaultId: 'medicine', relativePath: 'Archive/README.md' });
    expect(test.openFile).toHaveBeenCalledTimes(1);
    expect(test.openFile).toHaveBeenCalledWith(expect.objectContaining({
      vaultId: 'medicine', relativePath: 'Archive/README.md',
    }));
  });

  it('coalesces catalog events, emits appearance separately, and honors unsubscribe', async () => {
    const events: MultiVaultApiEvent[] = [];
    const unsubscribe = test.api.subscribe((event) => events.push(event));

    test.emitCatalogChanged();
    test.emitCatalogChanged();
    test.settings.virtualLinks!.colorMode = 'muted-text';
    test.api.refreshConfiguration();
    await flushEvents();
    expect(events).toEqual([
      { kind: 'catalog-changed' },
      { kind: 'appearance-changed' },
    ]);

    unsubscribe();
    test.emitCatalogChanged();
    test.settings.virtualLinks!.colorMode = 'soft-pill';
    test.api.refreshConfiguration();
    await flushEvents();
    expect(events).toHaveLength(2);
  });

  it('becomes inert and releases subscriptions after disposal', async () => {
    const listener = vi.fn();
    test.api.subscribe(listener);
    test.api.dispose();

    test.emitCatalogChanged();
    test.settings.virtualLinks!.colorMode = 'muted-text';
    test.api.refreshConfiguration();
    await test.api.openTarget({ vaultId: 'medicine', relativePath: 'README.md' });
    await flushEvents();

    expect(listener).not.toHaveBeenCalled();
    expect(test.openFile).not.toHaveBeenCalled();
    expect(test.api.getCurrentVault()).toBeNull();
    expect(test.api.getVirtualLinkSettings().enabled).toBe(false);
    expect(test.api.listVirtualLinkTargets()).toEqual([]);
    expect(test.api.resolveTarget({ vaultName: 'medicine', noteRef: 'README' }))
      .toEqual({ kind: 'missing' });
  });
});

describe('effective virtual-link enablement', () => {
  let test: ReturnType<typeof harness>;

  beforeEach(() => {
    test = harness();
  });

  it('is disabled when the source vault has selected no target vault at all', () => {
    test.settings.virtualLinks!.targetVaultIdsBySource = {};
    expect(test.api.getVirtualLinkSettings().enabled).toBe(false);
    expect(test.api.listVirtualLinkTargets()).toEqual([]);

    test.settings.virtualLinks!.targetVaultIdsBySource = { ideas: [] };
    expect(test.api.getVirtualLinkSettings().enabled).toBe(false);
  });

  it('is disabled when only the source vault itself is selected', () => {
    test.settings.virtualLinks!.targetVaultIdsBySource = { ideas: ['ideas'] };
    expect(test.api.getVirtualLinkSettings().enabled).toBe(false);
    expect(test.api.listVirtualLinkTargets()).toEqual([]);
  });

  it('is disabled when every selected target vault is unknown or disabled', () => {
    test.settings.virtualLinks!.targetVaultIdsBySource = { ideas: ['ghost', 42 as never] };
    expect(test.api.getVirtualLinkSettings().enabled).toBe(false);

    test.settings.virtualLinks!.targetVaultIdsBySource = { ideas: ['medicine'] };
    test.settings.vaults.find((vault) => vault.id === 'medicine')!.enabled = false;
    expect(test.api.getVirtualLinkSettings().enabled).toBe(false);
    expect(test.api.listVirtualLinkTargets()).toEqual([]);
  });

  it('is enabled and lists only the valid targets when at least one external vault survives', () => {
    test.settings.virtualLinks!.targetVaultIdsBySource = {
      ideas: ['ghost', 'ideas', 'medicine', 'medicine'],
    };
    expect(test.api.getVirtualLinkSettings().enabled).toBe(true);
    expect(test.api.listVirtualLinkTargets().map(({ identity }) => identity.vaultId))
      .toEqual(['medicine', 'medicine', 'medicine']);
  });
});

describe('configuration refresh events', () => {
  let test: ReturnType<typeof harness>;
  let events: MultiVaultApiEvent[];

  beforeEach(() => {
    test = harness();
    events = [];
    test.api.subscribe((event) => events.push(event));
  });

  it('emits nothing when a save changed nothing the API exposes', async () => {
    test.settings.savedSearches = [{ name: 'unrelated', query: 'x' } as never];
    test.api.refreshConfiguration();
    await flushEvents();
    expect(events).toEqual([]);
  });

  it('emits appearance only for a style-only change', async () => {
    test.settings.virtualLinks!.colorIntensity = 80;
    test.api.refreshConfiguration();
    await flushEvents();
    expect(events).toEqual([{ kind: 'appearance-changed' }]);
  });

  it('emits catalog for a target-scope change even when no index refresh runs', async () => {
    test.settings.virtualLinks!.targetVaultIdsBySource = { ideas: ['hobbies'] };
    test.api.refreshConfiguration();
    await flushEvents();
    expect(events).toContainEqual({ kind: 'catalog-changed' });
    expect(test.api.listVirtualLinkTargets().map(({ identity }) => identity.vaultId))
      .toEqual(['hobbies']);
  });

  it('emits catalog when the integration is globally disabled', async () => {
    test.settings.virtualLinks!.enabled = false;
    test.api.refreshConfiguration();
    await flushEvents();
    expect(events).toEqual([{ kind: 'catalog-changed' }]);
  });

  it('emits both categories when catalog and appearance both changed', async () => {
    test.settings.virtualLinks!.targetVaultIdsBySource = { ideas: ['hobbies'] };
    test.settings.virtualLinks!.colorMode = 'colored-underline';
    test.api.refreshConfiguration();
    await flushEvents();
    expect(events).toEqual([
      { kind: 'catalog-changed' },
      { kind: 'appearance-changed' },
    ]);
  });

  it('emits catalog when a target vault is renamed', async () => {
    test.settings.vaults.find((vault) => vault.id === 'medicine')!.name = 'Medicine';
    test.api.refreshConfiguration();
    await flushEvents();
    expect(events).toEqual([{ kind: 'catalog-changed' }]);
  });
});

describe('canonical identity is platform-aware', () => {
  const caseVariants: IndexedFile[] = [
    indexed('medicine', 'Notes/Case.md'),
    indexed('medicine', 'Notes/case.md'),
  ];

  it('keeps case-distinct note paths separate on case-sensitive platforms', async () => {
    const test = harness('linux');
    test.setFiles(caseVariants);

    expect(test.api.listVirtualLinkTargets().map(({ identity }) => identity.relativePath))
      .toEqual(['Notes/Case.md', 'Notes/case.md']);

    await test.api.openTarget({ vaultId: 'medicine', relativePath: 'Notes/case.md' });
    expect(test.openFile).toHaveBeenCalledWith(expect.objectContaining({
      relativePath: 'Notes/case.md',
    }));
  });

  it('folds case-only path differences on Windows', () => {
    const test = harness('win32');
    test.setFiles(caseVariants);

    expect(test.api.listVirtualLinkTargets().map(({ identity }) => identity.relativePath))
      .toEqual(['Notes/Case.md']);
  });
});
