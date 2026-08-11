import { beforeAll, describe, expect, it, vi } from 'vitest';
import { MultiVaultPublicApi } from '../src/api/multi-vault-public-api';
import type { MultiVaultApiEvent } from '../src/api/public-api-types';
import type { IndexedFile, MultiVaultSettings, VaultConfig } from '../src/types';

const TARGET_FILE_COUNT = 28_000;
const DUPLICATE_BASENAME_GROUPS = 464;
// Deliberately loose: this guards against reintroducing per-call content or disk work,
// not against ordinary machine-to-machine variance.
const WARM_LISTING_BUDGET_MS = 750;

const vaults: VaultConfig[] = [
  { id: 'ideas', name: 'Ideas', path: 'C:/vaults/Ideas', enabled: true, color: '#fa0000' },
  { id: 'medicine', name: 'Medicine', path: 'C:/vaults/Medicine', enabled: true, color: '#ac20df' },
  { id: 'hobbies', name: 'Hobbies', path: 'C:/vaults/Hobbies', enabled: true, color: '#1fe1e5' },
  { id: 'mathematics', name: 'Mathematics', path: 'C:/vaults/Mathematics', enabled: true, color: '#d4c30c' },
];
const targetVaultIds = ['medicine', 'hobbies', 'mathematics'];

/** Synthetic catalog only: no production vault is read, and no file exists on disk. */
function generateIndexedFiles(): IndexedFile[] {
  const files: IndexedFile[] = [];
  for (let index = 0; index < TARGET_FILE_COUNT; index += 1) {
    const vaultId = targetVaultIds[index % targetVaultIds.length];
    const vault = vaults.find((candidate) => candidate.id === vaultId)!;
    // Every DUPLICATE_BASENAME_GROUPS-th name repeats across folders, so duplicate
    // resolution has to work on full paths rather than basenames.
    const basename = index % 2 === 0
      ? `Shared Concept ${index % DUPLICATE_BASENAME_GROUPS}`
      : `Unique Note ${index}`;
    const relativePath = `Folder ${index % 97}/${basename}.md`;
    files.push({
      id: `${vaultId}:${relativePath}:${index}`,
      vaultId,
      vaultName: vault.name,
      absolutePath: `${vault.path}/${relativePath}`,
      relativePath,
      basename,
      extension: '.md',
      mtime: index,
      size: 128,
      frontmatter: { aliases: [`alias ${index}`, `Alias ${index}`, ` ${basename} abbrev `] },
      contentPreview: `synthetic body ${index}`,
    });
  }
  return files;
}

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
      targetVaultIdsBySource: { ideas: targetVaultIds },
      colorMode: 'soft-pill',
      colorIntensity: 55,
    },
  };
}

let files: IndexedFile[];

function harness() {
  const settings = makeSettings();
  const catalogListeners = new Set<() => void>();
  const getIndexedFiles = vi.fn(() => files);
  const api = new MultiVaultPublicApi(
    settings,
    {
      getCurrentVaultId: () => 'ideas',
      getVaultById: (vaultId: string) => settings.vaults.find((vault) => vault.id === vaultId),
    },
    {
      getIndexedFiles,
      onCatalogChanged: (listener: () => void) => {
        catalogListeners.add(listener);
        return () => catalogListeners.delete(listener);
      },
    },
    { openFile: vi.fn(async () => undefined) },
    'win32',
  );
  return {
    api,
    settings,
    getIndexedFiles,
    emitCatalogChanged() {
      for (const listener of catalogListeners) listener();
    },
  };
}

beforeAll(() => {
  files = generateIndexedFiles();
});

describe('public API projection over a large catalog', () => {
  it('projects every eligible target from metadata alone, without note content', () => {
    const test = harness();
    const targets = test.api.listVirtualLinkTargets();

    expect(targets).toHaveLength(TARGET_FILE_COUNT);
    const serialized = JSON.stringify(targets.slice(0, 2_000));
    expect(serialized).not.toContain('synthetic body');
    expect(serialized).not.toContain('absolutePath');
    expect(serialized).not.toContain('contentPreview');
    // Case-insensitive alias deduplication still applies at this size.
    expect(targets[0].aliases).toEqual(['alias 0', 'Shared Concept 0 abbrev']);
  });

  it('keeps warm listing responsive', () => {
    const test = harness();
    test.api.listVirtualLinkTargets();

    const startedAt = performance.now();
    const targets = test.api.listVirtualLinkTargets();
    const elapsed = performance.now() - startedAt;

    expect(targets).toHaveLength(TARGET_FILE_COUNT);
    expect(elapsed).toBeLessThan(WARM_LISTING_BUDGET_MS);
  });

  it('preserves every duplicate candidate instead of guessing across a large catalog', () => {
    const test = harness();
    const resolution = test.api.resolveTarget({ vaultName: 'Medicine', noteRef: 'Shared Concept 0' });

    expect(resolution.kind).toBe('ambiguous');
    if (resolution.kind !== 'ambiguous') return;
    expect(resolution.candidates.length).toBeGreaterThan(1);
    expect(new Set(resolution.candidates.map((candidate) => candidate.identity.relativePath)).size)
      .toBe(resolution.candidates.length);
  });

  it('does not re-read the catalog for an appearance-only change', async () => {
    const test = harness();
    const events: MultiVaultApiEvent[] = [];
    test.api.subscribe((event) => events.push(event));
    const callsBefore = test.getIndexedFiles.mock.calls.length;

    test.settings.virtualLinks!.colorIntensity = 80;
    test.api.refreshConfiguration();
    await Promise.resolve();

    expect(events).toEqual([{ kind: 'appearance-changed' }]);
    expect(test.getIndexedFiles.mock.calls.length).toBe(callsBefore);
  });

  it('coalesces a burst of catalog changes into one event', async () => {
    const test = harness();
    const events: MultiVaultApiEvent[] = [];
    test.api.subscribe((event) => events.push(event));

    for (let index = 0; index < 50; index += 1) test.emitCatalogChanged();
    test.settings.virtualLinks!.targetVaultIdsBySource = { ideas: ['medicine'] };
    test.api.refreshConfiguration();
    await Promise.resolve();

    expect(events.filter((event) => event.kind === 'catalog-changed')).toHaveLength(1);
  });
});
