import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { App, PluginSettingTab } from 'obsidian';
import {
  FakeElement,
  Setting,
  __getOpenedModals,
  __resetObsidianMock,
  __setRequireApiVersionResult,
} from './mocks/obsidian';

import {
  IDEAS_APPROVED_PALETTE,
  SHARED_SETTING_FIELD_LABELS,
  loadIdeasSeed,
  makeSharedSeedPreview,
  SharedSettingsSeedModal,
} from '../src/modals/shared-settings-seed-modal';
import { makeSharedStatusModel } from '../src/modals/shared-settings-status-modal';
import { VirtualLinkTargetsModal } from '../src/modals/virtual-link-targets-modal';
import { SharedSettingsStore } from '../src/shared-settings/shared-settings-store';
import type { MultiVaultSettings } from '../src/types';
import { MultiVaultSettingsTab } from '../src/settings-tab';
import type MultiVaultNavigatorPlugin from '../src/main';
import type { VaultRegistry } from '../src/vault-registry';
import type { Indexer } from '../src/indexer/indexer';

const tempDirs: string[] = [];

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((fulfill) => {
    resolve = fulfill;
  });
  return { promise, resolve };
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function ideasSettings(root: string): MultiVaultSettings {
  const vaults = [
    ['ideas', 'Ideas', '#fa0000'],
    ['hobbies', 'Hobbies', '#1fe1e5'],
    ['mathematics', 'Mathematics', '#d4c30c'],
    ['medicine', 'Medicine', '#ac20df'],
  ] as const;
  return {
    vaults: vaults.map(([id, name, color]) => ({
      id,
      name,
      path: path.join(root, name),
      color,
      enabled: true,
    })),
    indexOptions: {
      maxPreviewChars: 1000,
      autoRefreshOnStartup: true,
      globalExcludePatterns: ['Local only'],
      storeSnippetsInCache: true,
    },
    savedSearches: [{ id: 'local', name: 'Local only', query: 'private' }],
    pinnedFiles: ['local.md'],
    uiStyle: 'modern',
    sharedSettingsEnabled: false,
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

async function createIdeasFixture(): Promise<{ root: string; settings: MultiVaultSettings }> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mvn-shared-ui-'));
  tempDirs.push(root);
  const settings = ideasSettings(root);
  for (const vault of settings.vaults) await mkdir(path.join(vault.path, '.obsidian'), { recursive: true });
  const pluginDirectory = path.join(root, 'Ideas', '.obsidian', 'plugins', 'multi-vault-navigator');
  await mkdir(pluginDirectory, { recursive: true });
  await writeFile(path.join(pluginDirectory, 'data.json'), JSON.stringify(settings), 'utf8');
  return { root, settings };
}

afterEach(async () => {
  vi.restoreAllMocks();
  __resetObsidianMock();
  await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('shared settings view models', () => {
  it('previews the approved Ideas palette and every synchronized field', async () => {
    const { settings } = await createIdeasFixture();
    const loaded = await loadIdeasSeed(settings.vaults, '.obsidian');
    const preview = makeSharedSeedPreview(loaded.seed, loaded.dataPath);

    expect(Object.fromEntries(preview.vaults.map((vault) => [vault.name, vault.color]))).toEqual(
      IDEAS_APPROVED_PALETTE,
    );
    expect(preview.synchronizedFields).toEqual(SHARED_SETTING_FIELD_LABELS);
    expect(preview.sourcePath).toBe(loaded.dataPath);
    expect(preview.vaults.every((vault) => path.isAbsolute(vault.path))).toBe(true);
    expect(loaded.seed.enabled).toBe(true);
    expect(loaded.seed.virtualLinks.colorIntensity).toBe(55);
    expect(JSON.stringify(loaded.seed)).not.toContain('Local only');
  });

  it('includes all status fields without dropping an error', () => {
    expect(makeSharedStatusModel({
      enabled: true,
      excluded: true,
      revision: 7,
      lastAppliedRevision: 6,
      lastAppliedAt: '2026-08-10T12:00:00.000Z',
      path: '/tmp/shared-settings-v1',
      error: 'permission denied',
      disposed: false,
    })).toEqual({
      path: '/tmp/shared-settings-v1',
      enabled: 'Enabled',
      revision: '7',
      lastAppliedRevision: '6',
      lastAppliedAt: '2026-08-10T12:00:00.000Z',
      exclusion: 'Excluded from synchronization',
      error: 'permission denied',
    });
  });
});

describe('shared settings controls', () => {
  it('refreshes declarative shared settings once per display and rerenders only after applied changes', async () => {
    __setRequireApiVersionResult(true);
    const { settings } = await createIdeasFixture();
    const applyLatest = vi.fn();
    const refresh = deferred<{
      kind: 'applied';
      revision: number;
      appearanceChanged: boolean;
      catalogChanged: boolean;
    } | {
      kind: 'unchanged';
      revision: number;
    }>();
    applyLatest.mockReturnValue(refresh.promise);
    const plugin = {
      settings,
      sharedSettingsService: {
        getStatus: () => ({ enabled: true, excluded: false }),
        publish: vi.fn(),
        applyLatest,
      },
      isSharedConfigurationEnabled: () => true,
      setSharedConfigurationEnabled: vi.fn(),
      syncSharedConfigurationNow: vi.fn(),
      showSharedConfigurationStatus: vi.fn(),
      saveSettings: vi.fn(),
      refreshSearchEngine: vi.fn(),
    } as unknown as MultiVaultNavigatorPlugin;
    const registry = {
      getVaults: () => settings.vaults,
      getCurrentVaultId: () => 'ideas',
    } as unknown as VaultRegistry;
    const nativeUpdate = vi.spyOn(PluginSettingTab.prototype, 'update').mockImplementation(function (this: MultiVaultSettingsTab) {
      this.getSettingDefinitions();
    });
    const tab = new MultiVaultSettingsTab(new App(), plugin, registry, {} as Indexer);
    const updateSpy = vi.spyOn(tab, 'update');

    tab.getSettingDefinitions();
    tab.getSettingDefinitions();
    expect(applyLatest).toHaveBeenCalledOnce();
    expect(applyLatest).toHaveBeenCalledWith(true);
    expect(updateSpy).not.toHaveBeenCalled();

    refresh.resolve({
      kind: 'applied',
      revision: 1,
      appearanceChanged: true,
      catalogChanged: false,
    });
    await flushPromises();

    expect(updateSpy).toHaveBeenCalledOnce();
    expect(nativeUpdate).toHaveBeenCalledOnce();
    expect(applyLatest).toHaveBeenCalledOnce();
  });

  it('does not rerender or loop when declarative shared settings are already current', async () => {
    __setRequireApiVersionResult(true);
    const { settings } = await createIdeasFixture();
    const applyLatest = vi.fn(async () => ({ kind: 'unchanged' as const, revision: 7 }));
    const plugin = {
      settings,
      sharedSettingsService: {
        getStatus: () => ({ enabled: true, excluded: false }),
        publish: vi.fn(),
        applyLatest,
      },
      isSharedConfigurationEnabled: () => true,
      setSharedConfigurationEnabled: vi.fn(),
      syncSharedConfigurationNow: vi.fn(),
      showSharedConfigurationStatus: vi.fn(),
      saveSettings: vi.fn(),
      refreshSearchEngine: vi.fn(),
    } as unknown as MultiVaultNavigatorPlugin;
    const registry = {
      getVaults: () => settings.vaults,
      getCurrentVaultId: () => 'ideas',
    } as unknown as VaultRegistry;
    const nativeUpdate = vi.spyOn(PluginSettingTab.prototype, 'update').mockImplementation(function (this: MultiVaultSettingsTab) {
      this.getSettingDefinitions();
    });
    const tab = new MultiVaultSettingsTab(new App(), plugin, registry, {} as Indexer);
    const updateSpy = vi.spyOn(tab, 'update');

    tab.getSettingDefinitions();
    tab.getSettingDefinitions();
    await flushPromises();

    expect(applyLatest).toHaveBeenCalledOnce();
    expect(applyLatest).toHaveBeenCalledWith(true);
    expect(updateSpy).not.toHaveBeenCalled();
    expect(nativeUpdate).not.toHaveBeenCalled();
  });

  it('offers all Virtual Linker styles and publishes explicit shared patches', async () => {
    const { settings } = await createIdeasFixture();
    settings.sharedSettingsEnabled = true;
    const publish = vi.fn(async (patch: { kind: string; mode?: string; intensity?: number }) => {
      if (patch.kind === 'set-virtual-link-style' && settings.virtualLinks) {
        settings.virtualLinks.colorMode = patch.mode as NonNullable<MultiVaultSettings['virtualLinks']>['colorMode'];
        settings.virtualLinks.colorIntensity = patch.intensity ?? 55;
      }
      return {
        kind: 'applied' as const,
        revision: 1,
        appearanceChanged: true,
        catalogChanged: false,
      };
    });
    const plugin = {
      settings,
      sharedSettingsService: {
        getStatus: () => ({ enabled: true, excluded: false }),
        publish,
        applyLatest: vi.fn(async () => ({ kind: 'unchanged' as const, revision: 0 })),
      },
      isSharedConfigurationEnabled: () => true,
      setSharedConfigurationEnabled: vi.fn(),
      syncSharedConfigurationNow: vi.fn(),
      showSharedConfigurationStatus: vi.fn(),
      saveSettings: vi.fn(),
      refreshSearchEngine: vi.fn(),
    } as unknown as MultiVaultNavigatorPlugin;
    const registry = {
      getVaults: () => settings.vaults,
      getCurrentVaultId: () => 'ideas',
    } as unknown as VaultRegistry;
    const tab = new MultiVaultSettingsTab(new App(), plugin, registry, {} as Indexer);
    const definitions = tab.getSettingDefinitions();
    // Virtual Linker controls live in their own group, so a user without that
    // plugin can see at a glance which settings depend on it.
    const virtualLinkerGroup = definitions.find((definition) => (
      'type' in definition
      && definition.type === 'group'
      && typeof definition.heading === 'string'
      && definition.heading.startsWith('Cross-vault virtual links')
    ));
    if (!virtualLinkerGroup || !('items' in virtualLinkerGroup)) {
      throw new Error('Cross-vault virtual links group is missing.');
    }

    type RenderItem = { name?: string | DocumentFragment; render?: (setting: unknown) => unknown };
    const virtualLinkerItems = (virtualLinkerGroup.items ?? []) as RenderItem[];
    const modeItem = virtualLinkerItems.find((item) => item.name === 'Virtual-link color mode');
    const intensityItem = virtualLinkerItems.find((item) => item.name === 'Virtual-link color intensity');
    expect(virtualLinkerItems[0].name).toBe('Virtual Linker plugin');
    const modeContainer = new FakeElement();
    const modeSetting = new Setting(modeContainer);
    modeItem?.render?.(modeSetting);
    expect([...modeSetting.dropdowns[0].options.keys()]).toEqual([
      'off',
      'muted-text',
      'colored-underline',
      'soft-pill',
    ]);
    await modeSetting.dropdowns[0].triggerChange('colored-underline');

    const intensityContainer = new FakeElement();
    const intensitySetting = new Setting(intensityContainer);
    intensityItem?.render?.(intensitySetting);
    expect(intensitySetting.sliders[0]).toMatchObject({ minimum: 10, maximum: 90, value: 55 });
    await intensitySetting.sliders[0].triggerChange(70);

    expect(publish).toHaveBeenNthCalledWith(1, {
      kind: 'set-virtual-link-style',
      mode: 'colored-underline',
      intensity: 55,
    });
    expect(publish).toHaveBeenNthCalledWith(2, {
      kind: 'set-virtual-link-style',
      mode: 'colored-underline',
      intensity: 70,
    });
    expect(plugin.saveSettings).not.toHaveBeenCalled();
  });
});

describe('shared settings confirmation and target selection', () => {
  it('does not initialize on cancel and initializes only after confirmation', async () => {
    const { settings } = await createIdeasFixture();
    const loaded = await loadIdeasSeed(settings.vaults, '.obsidian');
    const storeRoot = await mkdtemp(path.join(os.tmpdir(), 'mvn-shared-ui-store-'));
    tempDirs.push(storeRoot);
    const store = new SharedSettingsStore(storeRoot);
    const app = new App();

    const cancelled = new SharedSettingsSeedModal(app, store, 'writer', loaded.seed, loaded.dataPath);
    cancelled.open();
    cancelled.close();
    expect(await store.read()).toBeNull();

    const initialized = vi.fn();
    const confirmed = new SharedSettingsSeedModal(
      app,
      store,
      'writer',
      loaded.seed,
      loaded.dataPath,
      initialized,
    );
    confirmed.open();
    const openModal = __getOpenedModals().at(-1) as unknown as SharedSettingsSeedModal;
    const openContent = openModal.contentEl as unknown as FakeElement;
    const confirmButton = openContent.settings.flatMap((setting) => setting.buttons)
      .find((button) => button.buttonText === 'Enable synchronization');
    await confirmButton?.triggerClick();

    expect((await store.read())?.revision).toBe(0);
    expect(initialized).toHaveBeenCalledOnce();
  });

  it('lists only non-source vaults and publishes one selection on Save', async () => {
    const app = new App();
    const onSave = vi.fn(async () => undefined);
    const candidates = [
      { id: 'ideas', name: 'Ideas', path: '/vaults/Ideas', color: '#fa0000', enabled: true },
      { id: 'medicine', name: 'Medicine', path: '/vaults/Medicine', color: '#ac20df', enabled: true },
      { id: 'hobbies', name: 'Hobbies', path: '/vaults/Hobbies', color: '#1fe1e5', enabled: true },
    ];
    const modal = new VirtualLinkTargetsModal(app, candidates[0], candidates, ['medicine'], onSave);
    modal.open();

    const content = modal.contentEl as unknown as FakeElement;
    expect(content.settings.map((setting) => setting.name)).toEqual([
      'Medicine',
      'Hobbies',
      'Save target vaults',
    ]);
    expect(content.settings[0].desc).toContain('/vaults/Medicine');
    await content.settings[1].toggles[0].triggerChange(true);
    await content.settings[2].buttons[1].triggerClick();

    expect(onSave).toHaveBeenCalledOnce();
    expect(onSave).toHaveBeenCalledWith(['medicine', 'hobbies']);
  });
});
