import { ButtonComponent, ItemView, Notice, WorkspaceLeaf } from 'obsidian';
import type { UnresolvedLinksController } from '../unresolved-links/unresolved-links-controller';
import { UnresolvedLinksViewModel } from '../unresolved-links/unresolved-links-view-model';

export const VIEW_TYPE_UNRESOLVED_LINKS = 'mvn-unresolved-links-view';

export class UnresolvedLinksView extends ItemView {
  private model: UnresolvedLinksViewModel | null = null;
  private status = '';

  constructor(leaf: WorkspaceLeaf, private readonly controller: UnresolvedLinksController) { super(leaf); }
  getViewType(): string { return VIEW_TYPE_UNRESOLVED_LINKS; }
  getDisplayText(): string { return 'Unresolved Cross-Vault Links'; }
  getIcon(): string { return 'wand-sparkles'; }

  async onOpen(): Promise<void> { await this.scan(); }

  private async scan(): Promise<void> {
    this.contentEl.empty();
    this.contentEl.addClass('mvn-unresolved-links');
    this.contentEl.createEl('h2', { text: 'Unresolved Cross-Vault Links' });
    this.contentEl.createEl('p', { text: 'Scanning the current vault…', cls: 'mvn-unresolved-status' });
    try {
      this.model = new UnresolvedLinksViewModel(await this.controller.scan());
      this.render();
    } catch (error) {
      this.contentEl.empty();
      this.contentEl.createEl('h2', { text: 'Unresolved Cross-Vault Links' });
      this.contentEl.createEl('p', { text: error instanceof Error ? error.message : String(error), cls: 'mvn-unresolved-error' });
    }
  }

  private render(): void {
    if (!this.model) return;
    const model = this.model;
    this.contentEl.empty();
    this.contentEl.addClass('mvn-unresolved-links');
    this.contentEl.createEl('h2', { text: 'Unresolved Cross-Vault Links' });
    this.contentEl.createEl('p', { text: 'Review unresolved links in this vault and connect them to notes that already exist elsewhere.' });
    if (this.status) this.contentEl.createEl('p', { text: this.status, cls: 'mvn-unresolved-status' });

    const missing = model.plan.groups.filter(group => group.candidates.length === 0);
    const proposals = model.plan.groups.filter(group => group.candidates.length > 0);
    const toolbar = this.contentEl.createDiv({ cls: 'mvn-unresolved-toolbar' });
    new ButtonComponent(toolbar).setButtonText('Select unambiguous').onClick(() => { model.selectAllUnambiguous(); this.render(); });
    new ButtonComponent(toolbar).setButtonText('Clear').onClick(() => { model.clear(); this.render(); });
    new ButtonComponent(toolbar).setButtonText('Rescan').onClick(() => { void this.scan(); });
    const convert = new ButtonComponent(toolbar).setButtonText('Convert selected').setCta();
    convert.setDisabled(model.selected().length === 0);
    convert.onClick(() => { void this.convertSelected(); });

    this.contentEl.createEl('p', {
      text: `${proposals.length} target${proposals.length === 1 ? '' : 's'} with candidates; ${missing.length} without candidates.`,
      cls: 'mvn-unresolved-summary',
    });
    if (proposals.length === 0) {
      this.contentEl.createEl('p', { text: 'No unresolved links match notes in other available vaults.' });
      return;
    }

    const list = this.contentEl.createDiv({ cls: 'mvn-unresolved-list' });
    for (const group of proposals) {
      const row = list.createDiv({ cls: 'mvn-unresolved-row' });
      const header = row.createDiv({ cls: 'mvn-unresolved-row-header' });
      const checkbox = header.createEl('input', { type: 'checkbox' });
      checkbox.checked = model.isEnabled(group.id);
      checkbox.disabled = !model.choice(group.id);
      checkbox.setAttr('aria-label', `Convert ${group.target}`);
      checkbox.addEventListener('change', () => { model.setEnabled(group.id, checkbox.checked); this.render(); });
      header.createEl('strong', { text: group.target });
      const noteCount = new Set(group.occurrences.map(item => item.sourcePath)).size;
      header.createSpan({ text: `${group.occurrences.length} occurrence${group.occurrences.length === 1 ? '' : 's'} in ${noteCount} note${noteCount === 1 ? '' : 's'}` });

      const select = row.createEl('select', { cls: 'mvn-unresolved-candidate' });
      if (group.candidates.length > 1) select.createEl('option', { text: 'Choose a destination…', value: '' });
      for (const candidate of group.candidates) {
        select.createEl('option', { text: `${candidate.vaultName} / ${candidate.relativePath}`, value: candidate.id });
      }
      select.value = model.choice(group.id) ?? '';
      select.addEventListener('change', () => { model.choose(group.id, select.value); this.render(); });

      const details = row.createEl('details');
      details.createEl('summary', { text: 'Affected notes' });
      const paths = [...new Set(group.occurrences.map(item => item.sourcePath))];
      const notes = details.createEl('ul');
      for (const sourcePath of paths) notes.createEl('li', { text: sourcePath });
    }
  }

  private async convertSelected(): Promise<void> {
    if (!this.model) return;
    try {
      const result = await this.controller.apply(this.model.plan, this.model.selected());
      if (result.failure) {
        this.status = `${result.failure}${result.rollbackFailures.length ? `; rollback failed for ${result.rollbackFailures.join(', ')}` : ''}`;
        new Notice(this.status);
        this.render();
        return;
      }
      this.status = `Converted ${result.convertedOccurrences} link${result.convertedOccurrences === 1 ? '' : 's'} in ${result.changedPaths.length} note${result.changedPaths.length === 1 ? '' : 's'}${result.stalePaths.length ? `; skipped ${result.stalePaths.length} stale note(s)` : ''}.`;
      await this.scan();
    } catch (error) {
      this.status = error instanceof Error ? error.message : String(error);
      new Notice(`Could not convert unresolved links: ${this.status}`);
      this.render();
    }
  }
}
