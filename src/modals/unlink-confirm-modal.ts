import { App, ButtonComponent, Modal, Setting } from 'obsidian';

import type { UnlinkPlan } from '../unlink-commands';

/** How many affected notes are worth listing before the dialog becomes a wall. */
const PREVIEW_LIMIT = 12;

function markButtonDestructive(button: ButtonComponent): ButtonComponent {
  const maybe = button as ButtonComponent & { setDestructive?: () => unknown };
  if (typeof maybe.setDestructive === 'function') maybe.setDestructive();
  else button.setWarning();
  return button;
}

export class UnlinkConfirmModal extends Modal {
  constructor(
    app: App,
    private readonly plan: UnlinkPlan,
    private readonly onConfirm: () => Promise<void>,
  ) {
    super(app);
  }

  onOpen(): void {
    const { notes, totalLinks } = this.plan;
    this.contentEl.empty();
    this.contentEl.createEl('h2', { text: 'Remove cross-vault links' });
    this.contentEl.createEl('p', {
      text: `${totalLinks} link${totalLinks === 1 ? '' : 's'} in ${notes.length} note${notes.length === 1 ? '' : 's'} `
        + 'will be replaced by the text they display. Links to notes in this vault are left alone.',
    });

    const list = this.contentEl.createEl('ul');
    for (const note of notes.slice(0, PREVIEW_LIMIT)) {
      list.createEl('li', { text: `${note.file.path} (${note.removed})` });
    }
    if (notes.length > PREVIEW_LIMIT) {
      list.createEl('li', { text: `and ${notes.length - PREVIEW_LIMIT} more` });
    }

    this.contentEl.createEl('p', {
      text: 'This rewrites files on disk. Commit or back up the vault first if you want a way back.',
      cls: 'mod-warning',
    });

    new Setting(this.contentEl)
      .addButton((button) => button.setButtonText('Cancel').onClick(() => this.close()))
      .addButton((button) => markButtonDestructive(button)
        .setButtonText('Remove links')
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
