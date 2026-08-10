import { App, Modal, Setting } from 'obsidian';
import type { MigrationPlan } from '../migration/migration-types';
import { makeMigrationReviewModel } from '../migration/migration-view-models';

export class MigrationReviewModal extends Modal {
  constructor(
    app: App,
    private readonly plan: MigrationPlan,
    private readonly onConfirm: () => Promise<void>,
  ) {
    super(app);
  }

  onOpen(): void {
    const model = makeMigrationReviewModel(this.plan);
    this.contentEl.empty();
    this.contentEl.createEl('h2', { text: 'Review Cross-Vault Changes' });
    if (model.destination) {
      this.contentEl.createEl('p', { text: `Destination: ${model.destination}` });
    } else {
      this.contentEl.createEl('p', { text: 'Standalone backlink relink; the current note will remain in place.' });
    }

    const summary = this.contentEl.createEl('ul', { cls: 'mvn-migration-summary' });
    summary.createEl('li', { text: `Outgoing links converted: ${model.outgoingLinks}` });
    summary.createEl('li', { text: `Backlinks converted: ${model.backlinks}` });
    summary.createEl('li', { text: `Source notes affected: ${model.affectedFiles}` });

    if (model.affectedPaths.length > 0) {
      this.contentEl.createEl('h3', { text: 'Source notes to update' });
      const paths = this.contentEl.createEl('ul', { cls: 'mvn-migration-paths' });
      for (const path of model.affectedPaths) paths.createEl('li', { text: path });
    }

    const skipped = Object.entries(model.skippedByReason);
    if (skipped.length > 0) {
      this.contentEl.createEl('h3', { text: 'Skipped links' });
      const list = this.contentEl.createEl('ul', { cls: 'mvn-migration-skipped' });
      for (const [reason, count] of skipped) list.createEl('li', { text: `${reason}: ${count}` });
    }

    new Setting(this.contentEl)
      .addButton((button) => button.setButtonText('Cancel').onClick(() => this.close()))
      .addButton((button) => button
        .setButtonText('Confirm')
        .setCta()
        .onClick(async () => {
          button.setDisabled(true);
          try {
            await this.onConfirm();
            this.close();
          } catch {
            button.setDisabled(false);
          }
        }));
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
