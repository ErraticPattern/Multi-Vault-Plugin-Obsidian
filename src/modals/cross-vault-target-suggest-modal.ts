import { App, FuzzySuggestModal, type FuzzyMatch } from 'obsidian';
import type { IndexedFile } from '../types';

export class CrossVaultTargetSuggestModal extends FuzzySuggestModal<IndexedFile> {
  constructor(
    app: App,
    private readonly candidates: IndexedFile[],
    private readonly onChoose: (target: IndexedFile) => void,
  ) {
    super(app);
    this.setPlaceholder('Choose the exact cross-vault note...');
  }

  getItems(): IndexedFile[] {
    return this.candidates;
  }

  getItemText(file: IndexedFile): string {
    return `${file.vaultName}  ${file.relativePath}`;
  }

  renderSuggestion(match: FuzzyMatch<IndexedFile>, element: HTMLElement): void {
    element.createDiv({ text: match.item.basename, cls: 'mvn-migration-suggestion-title' });
    element.createDiv({
      text: `${match.item.vaultName} · ${match.item.relativePath}`,
      cls: 'mvn-migration-suggestion-path',
    });
  }

  onChooseItem(file: IndexedFile): void {
    this.onChoose(file);
  }
}
