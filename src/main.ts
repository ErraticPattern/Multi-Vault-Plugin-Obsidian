import { randomUUID } from 'node:crypto';
import { FileSystemAdapter, Plugin } from 'obsidian';
import { DEFAULT_SETTINGS, MultiVaultSettings } from './types';
import { VaultRegistry } from './vault-registry';
import { Indexer } from './indexer/indexer';
import { SearchEngine } from './search-engine';
import { FileOpener } from './file-opener';
import { MultiVaultSettingsTab } from './settings-tab';
import { registerCrossVaultLinks } from './cross-vault-links';
import { SearchModal } from './modals/search-modal';
import { SwitchVaultModal } from './modals/switch-vault-modal';
import { RecentFilesModal } from './modals/recent-files-modal';
import { FileOperationModal } from './modals/file-operation-modal';
import { RelinkBacklinksModal } from './modals/relink-backlinks-modal';
import { CrossVaultLinkModal } from './modals/cross-vault-link-modal';
import { DuplicateDetectorModal } from './modals/duplicate-detector-modal';
import { VIEW_TYPE_EXTERNAL_FILE, ExternalFileView } from './views/external-file-view';
import { CrossVaultSuggest } from './cross-vault-suggest';
import { registerUnlinkCommands } from './unlink-commands';
import { VIEW_TYPE_SEARCH_PAGE, SearchPageView } from './views/search-page-view';
import { VIEW_TYPE_TAG_EXPLORER, TagExplorerView } from './views/tag-explorer-view';
import { VIEW_TYPE_DAILY_DASHBOARD, DailyDashboardView } from './views/daily-dashboard-view';
import { VIEW_TYPE_SIDEBAR, SidebarView } from './views/sidebar-view';
import { Notice, WorkspaceLeaf } from 'obsidian';
import { MigrationController } from './migration/migration-controller';
import { registerMigrationCommands } from './migration/migration-commands';
import { SharedSettingsStore } from './shared-settings/shared-settings-store';
import {
  SharedSettingsService,
  resolveSharedSettingsApplicationDataRoot,
  type SyncApplyResult,
} from './shared-settings/shared-settings-service';
import { loadIdeasSeed, SharedSettingsSeedModal } from './modals/shared-settings-seed-modal';
import { SharedSettingsStatusModal } from './modals/shared-settings-status-modal';
import { MultiVaultPublicApi } from './api/multi-vault-public-api';
import type { MultiVaultPublicApiV1 } from './api/public-api-types';

export const SYNC_SHARED_SETTINGS_COMMAND_ID = 'multi-vault-sync-shared-settings';
export const SHOW_SHARED_SETTINGS_STATUS_COMMAND_ID = 'multi-vault-show-sync-status';

export default class MultiVaultNavigatorPlugin extends Plugin {
  settings: MultiVaultSettings = Object.assign({}, DEFAULT_SETTINGS);
  vaultRegistry: VaultRegistry;
  indexer: Indexer;
  searchEngine: SearchEngine;
  fileOpener: FileOpener;
  migrationController: MigrationController;
  sharedSettingsService: SharedSettingsService | null = null;
  private sharedSettingsStore: SharedSettingsStore | null = null;
  private sharedSettingsWriterInstanceId: string | null = null;
  private publicApiInstance: MultiVaultPublicApi | null = null;

  get publicApi(): MultiVaultPublicApiV1 | undefined {
    return this.publicApiInstance ?? undefined;
  }

  async onload() {
    await this.loadSettings();

    const adapter = this.app.vault.adapter;
    if (adapter instanceof FileSystemAdapter) {
      this.sharedSettingsStore = new SharedSettingsStore(resolveSharedSettingsApplicationDataRoot());
      this.sharedSettingsWriterInstanceId = randomUUID();
      this.sharedSettingsService = new SharedSettingsService({
        store: this.sharedSettingsStore,
        settings: this.settings,
        currentVaultPath: adapter.getBasePath(),
        writerInstanceId: this.sharedSettingsWriterInstanceId,
        setInterval: (callback, milliseconds) => (
          window.setInterval(callback, milliseconds) as unknown as ReturnType<typeof globalThis.setInterval>
        ),
        clearInterval: (handle) => window.clearInterval(handle as unknown as number),
        registerInterval: (handle) => {
          this.registerInterval(handle as unknown as number);
        },
      });
      const startupSync = await this.sharedSettingsService.initializeAndApplyToSettings();
      if (startupSync.kind === 'error') {
        new Notice(`Shared configuration was not applied: ${startupSync.message}`);
      }
    }

    const hasAuthoritativeSharedSettings = this.sharedSettingsService?.hasAuthoritativeManifest() === true;

    // Initialize core modules
    this.vaultRegistry = new VaultRegistry(this.app, this.settings, {
      autoDetect: !hasAuthoritativeSharedSettings,
    });
    
    // Save settings right away in case auto-detect added vaults
    this.settings.vaults = this.vaultRegistry.getVaults();
    await this.saveSettings();

    this.indexer = new Indexer(this.app, this.vaultRegistry, this.settings);
    this.searchEngine = new SearchEngine();
    this.fileOpener = new FileOpener(this.app, this.vaultRegistry);
    this.migrationController = new MigrationController(
      this.app,
      this.vaultRegistry,
      this.indexer,
      undefined,
      () => this.settings.crossVaultLinkFormat,
    );

    // Initialize indexer (load cache)
    await this.indexer.initialize();
    this.refreshSearchEngine();
    this.publicApiInstance = new MultiVaultPublicApi(
      this.settings,
      this.vaultRegistry,
      this.indexer,
      this.fileOpener,
    );

    // Register custom views
    this.registerView(
      VIEW_TYPE_EXTERNAL_FILE,
      (leaf) => new ExternalFileView(
        leaf,
        this.searchEngine,
        this.fileOpener,
        () => this.settings.crossVaultLinkFormat,
      )
    );
    this.registerView(
      VIEW_TYPE_SEARCH_PAGE,
      (leaf) => new SearchPageView(leaf, this, this.searchEngine, this.fileOpener)
    );
    this.registerView(
      VIEW_TYPE_TAG_EXPLORER,
      (leaf) => new TagExplorerView(leaf, this.indexer)
    );
    this.registerView(
      VIEW_TYPE_DAILY_DASHBOARD,
      (leaf) => new DailyDashboardView(leaf, this.indexer, this.fileOpener)
    );
    this.registerView(
      VIEW_TYPE_SIDEBAR,
      (leaf) => new SidebarView(leaf, this, this.fileOpener)
    );

    this.addRibbonIcon('library', 'Multi-Vault Sidebar', async () => {
       await this.activateSidebar();
    });

    // Register Modals Commands
    this.addCommand({
      id: 'multi-vault-search-page',
      name: 'Open Search Page',
      callback: async () => {
        const leaf = this.app.workspace.getLeaf(true);
        await leaf.setViewState({ type: VIEW_TYPE_SEARCH_PAGE, active: true });
        await this.app.workspace.revealLeaf(leaf);
      }
    });

    this.addCommand({
      id: 'multi-vault-tag-explorer',
      name: 'Open Global Tag Explorer',
      callback: async () => {
        const leaf = this.app.workspace.getLeaf(true);
        await leaf.setViewState({ type: VIEW_TYPE_TAG_EXPLORER, active: true });
        await this.app.workspace.revealLeaf(leaf);
      }
    });

    this.addCommand({
      id: 'multi-vault-daily-dashboard',
      name: 'Open Cross-Vault Daily Notes',
      callback: async () => {
        const leaf = this.app.workspace.getLeaf(true);
        await leaf.setViewState({ type: VIEW_TYPE_DAILY_DASHBOARD, active: true });
        await this.app.workspace.revealLeaf(leaf);
      }
    });

    this.addCommand({
      id: 'multi-vault-search',
      name: 'Search All Vaults',
      callback: () => {
        new SearchModal(this.app, this.searchEngine, this.fileOpener).open();
      }
    });

    this.addCommand({
      id: 'multi-vault-recent',
      name: 'Recent Files',
      callback: () => {
        new RecentFilesModal(this.app, this.searchEngine, this.fileOpener).open();
      }
    });

    this.addCommand({
      id: 'multi-vault-switch',
      name: 'Switch Vault',
      callback: () => {
        new SwitchVaultModal(this.app, this.vaultRegistry, this.fileOpener).open();
      }
    });

    this.addCommand({
      id: 'multi-vault-refresh-index',
      name: 'Refresh Index',
      callback: async () => {
        await this.indexer.buildFullIndex(true);
        this.refreshSearchEngine();
      }
    });

    registerMigrationCommands(this, {
      openMoveCopy: () => {
        new FileOperationModal(
          this.app,
          this.vaultRegistry,
          this.indexer,
          this.migrationController,
        ).open();
      },
      openRelink: () => {
        new RelinkBacklinksModal(
          this.app,
          this.vaultRegistry,
          this.indexer,
          this.migrationController,
          () => this.settings.crossVaultLinkFormat,
        ).open();
      },
    });

    this.addCommand({
      id: 'multi-vault-duplicates',
      name: 'Find Duplicate Notes Across Vaults',
      callback: () => {
         new DuplicateDetectorModal(this.app, this.indexer, this.fileOpener).open();
      }
    });

    this.addCommand({
      id: 'multi-vault-copy-link',
      name: 'Copy Cross-Vault Link for Current File',
      callback: () => {
        const activeFile = this.app.workspace.getActiveFile();
        if (!activeFile) {
          new Notice('No active file');
          return;
        }
        new CrossVaultLinkModal(
          this.app,
          activeFile,
          this.vaultRegistry,
          () => this.settings.crossVaultLinkFormat,
        ).open();
      }
    });

    // Turns [[Note@vault]] back into the text it displays, for the whole note or
    // the whole vault.
    registerUnlinkCommands(this, {
      isKnownVault: () => {
        const names = new Set(this.vaultRegistry.getVaults().map((vault) => vault.name));
        return (vaultName: string) => names.has(vaultName);
      },
    });

    this.addCommand({
      id: 'multi-vault-clear-index',
      name: 'Clear Cross-Vault Index',
      callback: async () => {
        await this.indexer.clearIndex();
      }
    });

    this.addCommand({
      id: SYNC_SHARED_SETTINGS_COMMAND_ID,
      name: 'Sync shared configuration now',
      callback: async () => {
        await this.syncSharedConfigurationNow();
      },
    });

    this.addCommand({
      id: SHOW_SHARED_SETTINGS_STATUS_COMMAND_ID,
      name: 'Show shared configuration status',
      callback: () => {
        this.showSharedConfigurationStatus();
      },
    });

    // Register protocol handler
    this.registerObsidianProtocolHandler("mvn-open", async (params) => {
       const vaultId = params.vaultId;
       const filePath = params.file;
       if (!vaultId || !filePath) return;
       
       const files = this.indexer.getIndexedFiles();
       const target = files.find(f => f.vaultId === vaultId && f.relativePath === filePath);
       
       if (target) {
          await this.fileOpener.openFile(target);
       } else {
          new Notice("Cross-vault file not found in index. Please refresh index.");
       }
    });

    // Cross-vault [[vault::note]] links (Reading View rewrite + editor click intercept)
    registerCrossVaultLinks(this);

    // Add settings tab
    this.addSettingTab(new MultiVaultSettingsTab(this.app, this, this.vaultRegistry, this.indexer));

    // Typing "Note@" offers the notes with that name in the other vaults.
    this.registerEditorSuggest(new CrossVaultSuggest(
      this.app,
      this.indexer,
      this.vaultRegistry,
      () => this.settings.crossVaultLinkFormat,
    ));

    this.sharedSettingsService?.attachRuntime({
      replaceVaults: (vaults) => {
        this.vaultRegistry.replaceVaults(vaults);
        // Signal consumers from the canonical replacement itself so a later refresh
        // failure cannot swallow a target-scope change.
        this.publicApiInstance?.refreshConfiguration();
      },
      saveLocalMirror: async (settings) => {
        await this.saveData(settings);
      },
      onAppearanceChanged: () => {
        this.publicApiInstance?.refreshConfiguration();
        this.refreshSharedAppearance();
      },
      onCatalogChanged: async () => {
        this.publicApiInstance?.refreshConfiguration();
        await this.indexer.refreshIncremental(false);
        this.refreshSearchEngine();
        this.refreshSidebar();
      },
    });

    // Add ribbon icon
    this.addRibbonIcon('search', 'Multi-Vault Navigator', async () => {
      const leaf = this.app.workspace.getLeaf(true);
      await leaf.setViewState({ type: VIEW_TYPE_SEARCH_PAGE, active: true });
      await this.app.workspace.revealLeaf(leaf);
    });

    // Auto refresh index if needed (in a realistic app we would probably do it lazily or on a timer)
    if (this.settings.indexOptions.autoRefreshOnStartup) {
       // Using setTimeout to not block Obsidian startup
       window.setTimeout(() => {
         void this.refreshIndexInBackground();
       }, 5000);
    }
  }

  onunload() {
    this.publicApiInstance?.dispose();
    this.publicApiInstance = null;
    this.sharedSettingsService?.dispose();
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, (await this.loadData()) as Partial<MultiVaultSettings>);
  }

  async saveSettings() {
    this.settings.vaults = this.vaultRegistry.getVaults();
    await this.saveData({ ...this.settings, vaults: this.vaultRegistry.getPersistedVaults() });
    this.publicApiInstance?.refreshConfiguration();
  }

  isSharedConfigurationEnabled(): boolean {
    return this.sharedSettingsService?.getStatus().enabled
      ?? this.settings.sharedSettingsEnabled === true;
  }

  async setSharedConfigurationEnabled(enabled: boolean): Promise<void> {
    const service = this.sharedSettingsService;
    const store = this.sharedSettingsStore;
    const writerInstanceId = this.sharedSettingsWriterInstanceId;
    if (!service || !store || !writerInstanceId) {
      new Notice('Shared configuration requires a filesystem-backed desktop vault.');
      return;
    }

    if (!enabled) {
      const result = await service.publish({ kind: 'set-enabled', enabled: false });
      if (result.kind === 'disabled') {
        this.settings.sharedSettingsEnabled = false;
        await this.saveData(this.settings);
      } else {
        this.reportSharedSyncResult(result, 'Shared configuration');
      }
      return;
    }

    let existing;
    try {
      existing = await store.read();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      new Notice(`Shared configuration remains off: ${message}`);
      return;
    }

    if (existing) {
      const result = await service.publish({ kind: 'set-enabled', enabled: true });
      this.reportSharedSyncResult(result, 'Shared configuration');
      return;
    }

    try {
      const loaded = await loadIdeasSeed(this.vaultRegistry.getVaults(), this.app.vault.configDir);
      new SharedSettingsSeedModal(
        this.app,
        store,
        writerInstanceId,
        loaded.seed,
        loaded.dataPath,
        async () => {
          const result = await service.applyLatest(true);
          this.reportSharedSyncResult(result, 'Shared configuration initialized');
        },
      ).open();
    } catch (error) {
      this.settings.sharedSettingsEnabled = false;
      const message = error instanceof Error ? error.message : String(error);
      new Notice(`Shared configuration remains off: ${message}`);
    }
  }

  async syncSharedConfigurationNow(): Promise<SyncApplyResult | null> {
    if (!this.sharedSettingsService) {
      new Notice('Shared configuration is unavailable for this vault.');
      return null;
    }
    const result = await this.sharedSettingsService.applyLatest(true);
    this.reportSharedSyncResult(result, 'Shared configuration sync');
    return result;
  }

  showSharedConfigurationStatus(): void {
    if (!this.sharedSettingsService) {
      new Notice('Shared configuration is unavailable for this vault.');
      return;
    }
    new SharedSettingsStatusModal(this.app, this.sharedSettingsService.getStatus()).open();
  }

  private reportSharedSyncResult(result: SyncApplyResult, subject: string): void {
    switch (result.kind) {
      case 'applied':
        new Notice(`${subject}: applied revision ${result.revision}.`);
        return;
      case 'unchanged':
        new Notice(`${subject}: already current${result.revision === null ? '' : ` at revision ${result.revision}`}.`);
        return;
      case 'disabled':
        new Notice(`${subject}: synchronization is disabled at revision ${result.revision ?? 'unknown'}.`);
        return;
      case 'excluded':
        new Notice(`${subject}: this vault is excluded at revision ${result.revision}.`);
        return;
      case 'error':
        new Notice(`${subject} failed: ${result.message}`);
    }
  }

  public refreshSidebar() {
     const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_SIDEBAR);
     leaves.forEach(leaf => {
        if (leaf.view instanceof SidebarView) {
           leaf.view.render();
        }
     });
  }

  private refreshSharedAppearance(): void {
    this.refreshSidebar();
    this.app.workspace.trigger('layout-change');
  }

  private async activateSidebar() {
    const { workspace } = this.app;
    let leaf: WorkspaceLeaf | null = null;
    const leaves = workspace.getLeavesOfType(VIEW_TYPE_SIDEBAR);
    
    if (leaves.length > 0) {
      leaf = leaves[0];
    } else {
      leaf = workspace.getRightLeaf(false);
      await leaf?.setViewState({ type: VIEW_TYPE_SIDEBAR, active: true });
    }
    
    if (leaf) await workspace.revealLeaf(leaf);
  }

  refreshSearchEngine() {
    this.searchEngine.indexFiles(this.indexer.getIndexedFiles());
  }

  private async refreshIndexInBackground(): Promise<void> {
    try {
      await this.indexer.refreshIncremental(false);
      this.refreshSearchEngine();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      new Notice(`Failed to refresh cross-vault index: ${message}`);
    }
  }
}
