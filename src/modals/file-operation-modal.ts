import { App, Modal, Notice, Setting } from 'obsidian';
import type { Indexer } from '../indexer/indexer';
import { listDestinationFolders } from '../migration/destination-paths';
import type { MigrationController } from '../migration/migration-controller';
import { DestinationExistsError } from '../migration/migration-transaction';
import type { VaultRegistry } from '../vault-registry';
import { FolderSuggestModal } from './folder-suggest-modal';
import { MigrationReviewModal } from './migration-review-modal';

export function formatMigrationPlanningError(error: unknown): string {
  if (error instanceof DestinationExistsError) {
    return 'Destination already exists. Use “Relink Backlinks to Existing Cross-Vault Note” when this note already exists there.';
  }
  return `Could not prepare migration: ${error instanceof Error ? error.message : String(error)}`;
}

export class FileOperationModal extends Modal {
  private targetVaultId = '';
  private targetFolder = '/';
  private operation: 'move' | 'copy' = 'move';
  private preserveLinks = true;
  private overwriteDestination = false;
  private folderDescription: HTMLElement | null = null;

  constructor(
    app: App,
    private readonly vaultRegistry: VaultRegistry,
    private readonly indexer: Indexer,
    private readonly controller: MigrationController,
  ) {
    super(app);
  }

  onOpen(): void {
    this.overwriteDestination = false;
    const activeFile = this.app.workspace.getActiveFile();
    this.contentEl.empty();
    if (!activeFile || activeFile.extension.toLowerCase() !== 'md') {
      this.contentEl.createEl('h2', { text: 'No active Markdown note' });
      this.contentEl.createEl('p', { text: 'Open a Markdown note before moving or copying.' });
      return;
    }

    this.contentEl.createEl('h2', { text: 'Move / Copy File to Another Vault' });
    this.contentEl.createEl('p', { text: `File: ${activeFile.path}` });

    const currentVaultId = this.vaultRegistry.getCurrentVaultId();
    const otherVaults = this.vaultRegistry.getVaults().filter((vault) => vault.id !== currentVaultId);
    if (otherVaults.length === 0) {
      this.contentEl.createEl('p', { text: 'No other vaults are configured.' });
      return;
    }

    const recommendedVaultId = this.recommendVault(activeFile, currentVaultId);
    this.targetVaultId = recommendedVaultId || otherVaults[0].id;
    this.targetFolder = '/';

    new Setting(this.contentEl).setName('Target vault').addDropdown((dropdown) => {
      for (const vault of otherVaults) {
        dropdown.addOption(
          vault.id,
          vault.id === recommendedVaultId ? `✨ ${vault.name} (Recommended)` : vault.name,
        );
      }
      dropdown.setValue(this.targetVaultId).onChange((value) => {
        this.targetVaultId = value;
        this.targetFolder = '/';
        this.updateFolderDescription();
      });
    });

    const folderSetting = new Setting(this.contentEl)
      .setName('Destination folder (optional)')
      .setDesc('/ (vault root)')
      .addButton((button) => button.setButtonText('Choose folder').onClick(() => {
        const vault = this.vaultRegistry.getVaultById(this.targetVaultId);
        if (!vault) {
          new Notice('Choose a target vault first.');
          return;
        }
        try {
          new FolderSuggestModal(
            this.app,
            listDestinationFolders(vault.path),
            (folder) => {
              this.targetFolder = folder;
              this.updateFolderDescription();
            },
          ).open();
        } catch (error: unknown) {
          new Notice(`Could not list target folders: ${error instanceof Error ? error.message : String(error)}`);
        }
      }))
      .addButton((button) => button.setButtonText('Use vault root').onClick(() => {
        this.targetFolder = '/';
        this.updateFolderDescription();
      }));
    this.folderDescription = folderSetting.descEl;

    new Setting(this.contentEl).setName('Operation').addDropdown((dropdown) => dropdown
      .addOption('move', 'Move file')
      .addOption('copy', 'Copy file')
      .setValue(this.operation)
      .onChange((value) => { this.operation = value as 'move' | 'copy'; }));

    new Setting(this.contentEl)
      .setName('Preserve cross-vault links')
      .setDesc('Convert outgoing links in the destination; Move also redirects source-vault backlinks.')
      .addToggle((toggle) => toggle.setValue(this.preserveLinks).onChange((value) => {
        this.preserveLinks = value;
      }));

    new Setting(this.contentEl)
      .setName('Overwrite existing destination')
      .setDesc('Replace an existing destination note after a second confirmation.')
      .addToggle((toggle) => toggle.setValue(false).onChange((value) => {
        this.overwriteDestination = value;
      }));

    new Setting(this.contentEl).addButton((button) => button
      .setButtonText('Review changes')
      .setCta()
      .onClick(async () => {
        try {
          const plan = await this.controller.planMoveCopy(
            activeFile,
            this.targetVaultId,
            this.targetFolder,
            this.operation,
            this.preserveLinks,
            this.overwriteDestination,
          );
          new MigrationReviewModal(this.app, plan, async () => {
            try {
              const result = await this.controller.execute(plan);
              const indexWarning = result.indexUpdated
                ? ''
                : ` Migration succeeded, but the index update failed (${result.indexError}); run Refresh Index.`;
              new Notice(
                `${result.mode === 'move' ? 'Moved' : 'Copied'} ${activeFile.name}; ` +
                `${result.outgoingLinksRewritten} outgoing and ${result.backlinksRewritten} backlink(s) converted.` +
                indexWarning,
              );
              this.close();
            } catch (error: unknown) {
              new Notice(`Migration failed: ${error instanceof Error ? error.message : String(error)}`);
              throw error;
            }
          }).open();
        } catch (error: unknown) {
          new Notice(formatMigrationPlanningError(error));
        }
      }));
  }

  private recommendVault(activeFile: { path: string }, currentVaultId: string | null): string {
    const cache = this.app.metadataCache.getFileCache(activeFile as never);
    const tags: string[] = [];
    if (cache?.tags) tags.push(...cache.tags.map((tag) => tag.tag.replace('#', '').toLowerCase()));
    const frontmatterTags: unknown = cache?.frontmatter?.tags;
    if (Array.isArray(frontmatterTags)) tags.push(...frontmatterTags.map((tag) => String(tag).toLowerCase()));
    if (typeof frontmatterTags === 'string') {
      tags.push(...frontmatterTags.split(',').map((tag) => tag.trim().toLowerCase()));
    }
    if (tags.length === 0) return '';

    const scores = new Map<string, number>();
    for (const file of this.indexer.getIndexedFiles()) {
      if (file.vaultId === currentVaultId) continue;
      const score = (file.tags ?? []).filter((tag) => tags.includes(tag.toLowerCase())).length;
      if (score > 0) scores.set(file.vaultId, (scores.get(file.vaultId) ?? 0) + score);
    }
    return [...scores.entries()].sort((left, right) => right[1] - left[1])[0]?.[0] ?? '';
  }

  private updateFolderDescription(): void {
    this.folderDescription?.setText(this.targetFolder === '/' ? '/ (vault root)' : this.targetFolder);
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
