import { App, Modal, Setting } from 'obsidian';
import type { MigrationPlan } from '../migration/migration-types';
import { makeMigrationReviewModel } from '../migration/migration-view-models';
import { OverwriteConfirmModal } from './overwrite-confirm-modal';

export type MigrationReviewConfirmationResult = 'confirmed' | 'awaiting-overwrite-confirm';

export async function handleMigrationReviewConfirmation(
  plan: MigrationPlan,
  onConfirm: () => Promise<void>,
  openOverwriteConfirm: (destinationPath: string, onConfirm: () => Promise<void>) => void,
): Promise<MigrationReviewConfirmationResult> {
  if (plan.destinationPolicy === 'overwrite-reviewed') {
    if (!plan.destinationAbsolutePath) {
      throw new Error('Overwrite review is missing the destination path');
    }
    openOverwriteConfirm(plan.destinationAbsolutePath, onConfirm);
    return 'awaiting-overwrite-confirm';
  }
  await onConfirm();
  return 'confirmed';
}

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

    if (model.overwritesDestination && this.plan.destinationAbsolutePath) {
      const originalBytes = model.destinationOriginalBytes === 1
        ? '1 byte'
        : `${model.destinationOriginalBytes ?? 0} bytes`;
      this.contentEl.createEl('p', {
        text: `Warning: this will replace the existing destination note at ${this.plan.destinationAbsolutePath} (${originalBytes}). Confirming here opens one more overwrite confirmation before execution.`,
        cls: 'mod-warning',
      });
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
            const result = await handleMigrationReviewConfirmation(
              this.plan,
              async () => {
                await this.onConfirm();
                this.close();
              },
              (destinationPath, onConfirm) => {
                new OverwriteConfirmModal(this.app, destinationPath, onConfirm).open();
              },
            );
            if (result === 'awaiting-overwrite-confirm') {
              button.setDisabled(false);
            }
          } catch {
            button.setDisabled(false);
          }
        }));
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
