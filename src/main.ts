import { Plugin } from 'obsidian';
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
import { DuplicateDetectorModal } from './modals/duplicate-detector-modal';
import { VIEW_TYPE_EXTERNAL_FILE, ExternalFileView } from './views/external-file-view';
import { VIEW_TYPE_SEARCH_PAGE, SearchPageView } from './views/search-page-view';
import { VIEW_TYPE_TAG_EXPLORER, TagExplorerView } from './views/tag-explorer-view';
import { VIEW_TYPE_DAILY_DASHBOARD, DailyDashboardView } from './views/daily-dashboard-view';
import { VIEW_TYPE_SIDEBAR, SidebarView } from './views/sidebar-view';
import { Notice, WorkspaceLeaf } from 'obsidian';
import { MigrationController } from './migration/migration-controller';
import { registerMigrationCommands } from './migration/migration-commands';

export default class MultiVaultNavigatorPlugin extends Plugin {
  settings: MultiVaultSettings = Object.assign({}, DEFAULT_SETTINGS);
  vaultRegistry: VaultRegistry;
  indexer: Indexer;
  searchEngine: SearchEngine;
  fileOpener: FileOpener;
  migrationController: MigrationController;

  async onload() {
    await this.loadSettings();

    // Initialize core modules
    this.vaultRegistry = new VaultRegistry(this.app, this.settings);
    
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
    );

    // Initialize indexer (load cache)
    await this.indexer.initialize();
    this.refreshSearchEngine();

    // Register custom views
    this.registerView(
      VIEW_TYPE_EXTERNAL_FILE,
      (leaf) => new ExternalFileView(leaf, this.searchEngine, this.fileOpener)
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
      callback: async () => {
         const activeFile = this.app.workspace.getActiveFile();
         if (!activeFile) {
            new Notice("No active file");
            return;
         }
         const vaultId = this.vaultRegistry.getCurrentVaultId();
         const link = `[${activeFile.basename}](obsidian://mvn-open?vaultId=${vaultId}&file=${encodeURIComponent(activeFile.path)})`;
         await navigator.clipboard.writeText(link);
         new Notice("Cross-vault link copied to clipboard!");
      }
    });

    this.addCommand({
      id: 'multi-vault-clear-index',
      name: 'Clear Cross-Vault Index',
      callback: async () => {
        await this.indexer.clearIndex();
      }
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
    // Cleanup if needed
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, (await this.loadData()) as Partial<MultiVaultSettings>);
  }

  async saveSettings() {
    this.settings.vaults = this.vaultRegistry.getVaults();
    await this.saveData(this.settings);
  }

  public refreshSidebar() {
     const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_SIDEBAR);
     leaves.forEach(leaf => {
        if (leaf.view instanceof SidebarView) {
           leaf.view.render();
        }
     });
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
      await this.indexer.buildFullIndex(false);
      this.refreshSearchEngine();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      new Notice(`Failed to refresh cross-vault index: ${message}`);
    }
  }
}
