import { formatCrossVaultWikilink } from '../migration/cross-vault-link';
import type { CrossVaultLinkFormat } from '../cross-vault-syntax';
import { App, Modal, Notice, Setting } from 'obsidian';
import type { Indexer } from '../indexer/indexer';
import type { MigrationController } from '../migration/migration-controller';
import { makeRelinkPreviewModel } from '../migration/migration-view-models';
import { PreparedPlanCache } from '../migration/prepared-plan-cache';
import type { IndexedFile } from '../types';
import type { VaultRegistry } from '../vault-registry';
import { MigrationReviewModal } from './migration-review-modal';
import { TargetNoteSuggestModal } from './target-note-suggest-modal';

export class RelinkBacklinksModal extends Modal {
  private targetVaultId = '';
  private targetNote: IndexedFile | null = null;
  private targetNoteDescription: HTMLElement | null = null;
  private previewEl: HTMLElement | null = null;
  private previewGeneration = 0;
  private readonly preparedPlans = new PreparedPlanCache();

  constructor(
    app: App,
    private readonly vaultRegistry: VaultRegistry,
    private readonly indexer: Indexer,
    private readonly controller: MigrationController,
    private readonly linkFormat: () => CrossVaultLinkFormat | undefined = () => undefined,
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
        this.preparedPlans.invalidate();
        this.updateTargetDescription();
        void this.refreshPreview(activeFile);
      });
    });

    const noteSetting = new Setting(this.contentEl)
      .setName('Existing destination note (optional)')
      .setDesc('Using the current note name in the target vault')
      .addButton((button) => button.setButtonText('Choose note').onClick(() => {
        new TargetNoteSuggestModal(
          this.app,
          this.indexer.getIndexedFiles(),
          this.targetVaultId,
          (file) => {
            this.targetNote = file;
            this.preparedPlans.invalidate();
            this.updateTargetDescription();
            void this.refreshPreview(activeFile);
          },
        ).open();
      }))
      .addButton((button) => button.setButtonText('Use note name').onClick(() => {
        this.targetNote = null;
        this.preparedPlans.invalidate();
        this.updateTargetDescription();
        void this.refreshPreview(activeFile);
      }));
    this.targetNoteDescription = noteSetting.descEl;

    this.previewEl = this.contentEl.createDiv({ cls: 'mvn-relink-preview' });
    void this.refreshPreview(activeFile);

    new Setting(this.contentEl).addButton((button) => button
      .setButtonText('Review changes')
      .setCta()
      .onClick(async () => {
        try {
          const plan = await this.preparedPlans.getOrPrepare(
            this.planKey(),
            (prepared) => this.controller.isPlanCurrent(prepared, activeFile),
            () => this.controller.planRelink(
              activeFile,
              this.targetVaultId,
              this.targetNote ?? undefined,
            ),
          );
          new MigrationReviewModal(this.app, plan, async () => {
            try {
              const result = await this.controller.execute(plan);
              const indexWarning = result.indexUpdated
                ? ''
                : ` Migration succeeded, but the index update failed (${result.indexError}); run Refresh Index.`;
              new Notice(
                `Relinked ${result.backlinksRewritten} backlink(s). The source note was left unchanged.` +
                indexWarning,
              );
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
    this.targetNoteDescription?.setText(
      this.targetNote?.relativePath ?? 'Using the current note name in the target vault',
    );
  }

  private async refreshPreview(activeFile: import('obsidian').TFile): Promise<void> {
    if (!this.previewEl) return;
    const generation = ++this.previewGeneration;
    this.previewEl.empty();
    this.previewEl.createEl('h3', { text: 'Backlink preview' });
    this.previewEl.createEl('p', { text: 'Scanning current-vault backlinks…' });
    try {
      const plan = await this.preparedPlans.getOrPrepare(
        this.planKey(),
        (prepared) => this.controller.isPlanCurrent(prepared, activeFile),
        () => this.controller.planRelink(
          activeFile,
          this.targetVaultId,
          this.targetNote ?? undefined,
        ),
      );
      if (generation !== this.previewGeneration || !this.previewEl) return;
      const preview = makeRelinkPreviewModel(plan);
      this.previewEl.empty();
      this.previewEl.createEl('h3', { text: 'Backlink preview' });
      this.previewEl.createEl('p', {
        text: `Source vault: ${preview.backlinks} backlink(s) in ${preview.affectedFiles} note(s) will change.`,
      });
      const destination = preview.examples[0]?.after
        ?? formatCrossVaultWikilink(this.targetVaultName(), activeFile.basename, this.linkFormat());
      this.previewEl.createEl('p', {
        text: `Destination vault format: ${destination}`,
      });
      if (preview.examples.length > 0) {
        const list = this.previewEl.createEl('ul', { cls: 'mvn-relink-preview-examples' });
        for (const example of preview.examples.slice(0, 10)) {
          list.createEl('li', {
            text: `${example.sourcePath}: ${example.before} → ${example.after}`,
          });
        }
        if (preview.examples.length > 10) {
          list.createEl('li', { text: `…and ${preview.examples.length - 10} more` });
        }
      }
    } catch (error: unknown) {
      if (generation !== this.previewGeneration || !this.previewEl) return;
      this.previewEl.empty();
      this.previewEl.createEl('h3', { text: 'Backlink preview' });
      this.previewEl.createEl('p', {
        text: error instanceof Error ? error.message : String(error),
        cls: 'mod-warning',
      });
    }
  }

  private planKey(): string {
    return `${this.targetVaultId}:${this.targetNote?.relativePath ?? ''}`;
  }

  private targetVaultName(): string {
    return this.vaultRegistry.getVaultById(this.targetVaultId)?.name ?? this.targetVaultId;
  }

  onClose(): void {
    this.preparedPlans.invalidate();
    this.contentEl.empty();
  }
}
