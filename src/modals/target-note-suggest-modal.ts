import { App, FuzzySuggestModal, type FuzzyMatch } from 'obsidian';
import type { IndexedFile } from '../types';
import { getTargetNoteSuggestions } from '../migration/migration-view-models';

export class TargetNoteSuggestModal extends FuzzySuggestModal<IndexedFile> {
  private readonly notes: IndexedFile[];

  constructor(
    app: App,
    files: IndexedFile[],
    vaultId: string,
    private readonly onChoose: (file: IndexedFile) => void,
  ) {
    super(app);
    this.notes = getTargetNoteSuggestions(files, vaultId);
    this.setPlaceholder('Choose the existing destination note...');
  }

  getItems(): IndexedFile[] {
    return this.notes;
  }

  getItemText(file: IndexedFile): string {
    return `${file.basename}  ${file.relativePath}`;
  }

  renderSuggestion(match: FuzzyMatch<IndexedFile>, element: HTMLElement): void {
    element.createDiv({ text: match.item.basename, cls: 'mvn-migration-suggestion-title' });
    element.createDiv({ text: match.item.relativePath, cls: 'mvn-migration-suggestion-path' });
  }

  onChooseItem(file: IndexedFile): void {
    this.onChoose(file);
  }
}
