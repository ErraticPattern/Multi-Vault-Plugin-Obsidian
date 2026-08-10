import { App, FuzzySuggestModal } from 'obsidian';
import { getFolderSuggestions } from '../migration/migration-view-models';

export class FolderSuggestModal extends FuzzySuggestModal<string> {
  private readonly folders: string[];

  constructor(
    app: App,
    folders: string[],
    private readonly onChoose: (folder: string) => void,
  ) {
    super(app);
    this.folders = getFolderSuggestions(folders);
    this.setPlaceholder('Choose a destination folder...');
  }

  getItems(): string[] {
    return this.folders;
  }

  getItemText(folder: string): string {
    return folder === '/' ? '/ (vault root)' : folder;
  }

  onChooseItem(folder: string): void {
    this.onChoose(folder);
  }
}
