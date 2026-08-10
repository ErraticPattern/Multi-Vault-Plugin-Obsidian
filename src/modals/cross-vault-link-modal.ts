import { App, Modal, Notice, Setting, type TFile } from 'obsidian';
import { formatCrossVaultWikilink } from '../migration/cross-vault-link';
import type { VaultRegistry } from '../vault-registry';

export class CrossVaultLinkModal extends Modal {
  private targetVaultId = '';
  private previewEl: HTMLElement | null = null;

  constructor(
    app: App,
    private readonly activeFile: TFile,
    private readonly vaultRegistry: VaultRegistry,
  ) {
    super(app);
  }

  onOpen(): void {
    this.contentEl.empty();
    const vaults = this.vaultRegistry.getVaults();
    if (vaults.length === 0) {
      this.contentEl.createEl('p', { text: 'No vaults are configured.' });
      return;
    }
    this.targetVaultId = this.vaultRegistry.getCurrentVaultId() ?? vaults[0].id;

    this.contentEl.createEl('h2', { text: 'Copy Cross-Vault Link' });
    new Setting(this.contentEl)
      .setName('Link target vault')
      .setDesc('Choose the vault name to encode in the wikilink.')
      .addDropdown((dropdown) => {
        for (const vault of vaults) dropdown.addOption(vault.id, vault.name);
        dropdown.setValue(this.targetVaultId).onChange((value) => {
          this.targetVaultId = value;
          this.updatePreview();
        });
      });

    this.previewEl = this.contentEl.createDiv({ cls: 'mvn-cross-vault-link-preview' });
    this.updatePreview();

    new Setting(this.contentEl)
      .addButton((button) => button.setButtonText('Cancel').onClick(() => this.close()))
      .addButton((button) => button.setButtonText('Copy wikilink').setCta().onClick(async () => {
        const link = this.currentLink();
        if (!link) {
          new Notice('Choose a target vault first.');
          return;
        }
        await navigator.clipboard.writeText(link);
        new Notice(`Copied ${link}`);
        this.close();
      }));
  }

  private currentLink(): string | null {
    const vault = this.vaultRegistry.getVaultById(this.targetVaultId);
    return vault ? formatCrossVaultWikilink(vault.name, this.activeFile.basename) : null;
  }

  private updatePreview(): void {
    if (!this.previewEl) return;
    this.previewEl.empty();
    this.previewEl.createEl('code', { text: this.currentLink() ?? 'Choose a vault' });
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
