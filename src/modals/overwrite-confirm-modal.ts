import { App, ButtonComponent, Modal, Setting } from 'obsidian';

function markButtonDestructive(button: ButtonComponent): ButtonComponent {
  const maybe = button as ButtonComponent & { setDestructive?: () => unknown };
  if (typeof maybe.setDestructive === 'function') {
    maybe.setDestructive();
  } else {
    button.setWarning();
  }
  return button;
}

export class OverwriteConfirmModal extends Modal {
  constructor(
    app: App,
    private readonly destinationPath: string,
    private readonly onConfirm: () => Promise<void>,
  ) {
    super(app);
  }

  onOpen(): void {
    this.contentEl.empty();
    this.contentEl.createEl('h2', { text: 'Confirm Destination Overwrite' });
    this.contentEl.createEl('p', {
      text: `Replace existing note at ${this.destinationPath}? This cannot preserve its current contents if rollback also fails.`,
      cls: 'mod-warning',
    });

    new Setting(this.contentEl)
      .addButton((button) => button.setButtonText('Cancel').onClick(() => this.close()))
      .addButton((button) => markButtonDestructive(button)
        .setButtonText('Overwrite note')
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
