import { App, Modal, Notice, Setting } from 'obsidian';
import type { Indexer } from '../indexer/indexer';
import type { MigrationController } from '../migration/migration-controller';
import type { IndexedFile } from '../types';
import type { VaultRegistry } from '../vault-registry';
import { MigrationReviewModal } from './migration-review-modal';
import { TargetNoteSuggestModal } from './target-note-suggest-modal';

export class RelinkBacklinksModal extends Modal {
  private targetVaultId = '';
  private targetNote: IndexedFile | null = null;
  private targetNoteDescription: HTMLElement | null = null;

  constructor(
    app: App,
    private readonly vaultRegistry: VaultRegistry,
    private readonly indexer: Indexer,
    private readonly controller: MigrationController,
  ) {
    super(app);
  }

  onOpen(): void {
    const activeFile = this.app.workspace.getActiveFile();
    this.contentEl.empty();
    if (!activeFile || activeFile.extension.toLowerCase() !== 'md') {
      this.contentEl.createEl('h2', { text: 'No active Markdown note' });
      return;
    }

    const currentVaultId = this.vaultRegistry.getCurrentVaultId();
    const targets = this.vaultRegistry.getVaults().filter((vault) => vault.id !== currentVaultId);
    if (targets.length === 0) {
      this.contentEl.createEl('p', { text: 'No other vaults are configured.' });
      return;
    }
    this.targetVaultId = targets[0].id;

    this.contentEl.createEl('h2', { text: 'Relink Backlinks to Existing Cross-Vault Note' });
    this.contentEl.createEl('p', {
      text: `Source duplicate: ${activeFile.path}. This note will not be edited or deleted.`,
    });

    new Setting(this.contentEl).setName('Target vault').addDropdown((dropdown) => {
      for (const vault of targets) dropdown.addOption(vault.id, vault.name);
      dropdown.setValue(this.targetVaultId).onChange((value) => {
        this.targetVaultId = value;
        this.targetNote = null;
        this.updateTargetDescription();
      });
    });

    const noteSetting = new Setting(this.contentEl)
      .setName('Existing destination note')
      .setDesc('No note selected')
      .addButton((button) => button.setButtonText('Choose note').onClick(() => {
        new TargetNoteSuggestModal(
          this.app,
          this.indexer.getIndexedFiles(),
          this.targetVaultId,
          (file) => {
            this.targetNote = file;
            this.updateTargetDescription();
          },
        ).open();
      }));
    this.targetNoteDescription = noteSetting.descEl;

    new Setting(this.contentEl).addButton((button) => button
      .setButtonText('Review changes')
      .setCta()
      .onClick(async () => {
        if (!this.targetNote) {
          new Notice('Choose an existing destination note first.');
          return;
        }
        try {
          const plan = await this.controller.planRelink(activeFile, this.targetVaultId, this.targetNote);
          new MigrationReviewModal(this.app, plan, async () => {
            try {
              const result = await this.controller.execute(plan);
              new Notice(`Relinked ${result.backlinksRewritten} backlink(s). The source note was left unchanged.`);
              this.close();
            } catch (error: unknown) {
              new Notice(`Relink failed: ${error instanceof Error ? error.message : String(error)}`);
              throw error;
            }
          }).open();
        } catch (error: unknown) {
          new Notice(`Could not prepare relink: ${error instanceof Error ? error.message : String(error)}`);
        }
      }));
  }

  private updateTargetDescription(): void {
    this.targetNoteDescription?.setText(this.targetNote?.relativePath ?? 'No note selected');
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
