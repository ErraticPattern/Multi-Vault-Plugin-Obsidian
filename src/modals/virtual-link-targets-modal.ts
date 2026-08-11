import { App, Modal, Notice, Setting } from 'obsidian';

import type { VaultConfig } from '../types';

export class VirtualLinkTargetsModal extends Modal {
  private readonly selectedIds: Set<string>;
  private saving = false;

  constructor(
    app: App,
    private readonly sourceVault: VaultConfig,
    private readonly candidates: readonly VaultConfig[],
    selectedIds: readonly string[],
    private readonly onSave: (selectedIds: string[]) => Promise<void> | void,
  ) {
    super(app);
    this.selectedIds = new Set(selectedIds);
  }

  onOpen(): void {
    this.contentEl.empty();
    this.contentEl.createEl('h2', { text: `Virtual Link targets from ${this.sourceVault.name}` });
    this.contentEl.createEl('p', {
      text: 'Only selected external vaults are exposed as virtual-link targets for this source vault.',
    });

    const targetVaults = this.candidates.filter((vault) => vault.id !== this.sourceVault.id);
    for (const vault of targetVaults) {
      const color = vault.color ? `Color: ${vault.color}` : 'Color: theme default';
      new Setting(this.contentEl)
        .setName(vault.name)
        .setDesc(`${vault.path} · ${color}`)
        .addToggle((toggle) => toggle
          .setValue(this.selectedIds.has(vault.id))
          .onChange((selected) => {
            if (selected) this.selectedIds.add(vault.id);
            else this.selectedIds.delete(vault.id);
          }));
    }

    new Setting(this.contentEl)
      .setName('Save target vaults')
      .setDesc(targetVaults.length === 0 ? 'No other vaults are configured.' : 'Publish this source vault selection.')
      .addButton((button) => button
        .setButtonText('Cancel')
        .onClick(() => this.close()))
      .addButton((button) => button
        .setButtonText('Save')
        .setCta()
        .onClick(async () => {
          if (this.saving) return;
          this.saving = true;
          button.setDisabled(true);
          try {
            const selected = targetVaults
              .filter((vault) => this.selectedIds.has(vault.id))
              .map((vault) => vault.id);
            await this.onSave(selected);
            this.close();
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            new Notice(`Could not save virtual-link targets: ${message}`);
            button.setDisabled(false);
          } finally {
            this.saving = false;
          }
        }));
  }
}
