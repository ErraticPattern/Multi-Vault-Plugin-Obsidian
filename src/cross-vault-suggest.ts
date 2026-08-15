import {
  App,
  Editor,
  EditorPosition,
  EditorSuggest,
  EditorSuggestContext,
  EditorSuggestTriggerInfo,
  TFile,
} from 'obsidian';

import type { Indexer } from './indexer/indexer';
import type { VaultRegistry } from './vault-registry';
import type { IndexedFile } from './types';
import { formatCrossVaultTarget, type CrossVaultLinkFormat } from './cross-vault-syntax';

/** How many candidates are worth showing before the list becomes noise. */
const MAX_SUGGESTIONS = 20;

export interface CrossVaultSuggestion {
  vaultName: string;
  /** The note reference to write: a basename, or a path when the basename is ambiguous. */
  noteReference: string;
  relativePath: string;
}

/** Longest note name that may be completed from plain text, in words. */
const MAX_NAME_WORDS = 6;

/**
 * The note name being completed, taken from the text before the caret.
 *
 * Inside an unfinished `[[`, the brackets bound the name exactly. In plain text
 * there is nothing to bound it, since note names may contain spaces, so the
 * trailing words are tried longest first and the first one that names a real
 * note wins. "I read about Free Energy Principle@" therefore completes the
 * principle, not the sentence.
 */
export function noteNameBeforeAt(
  lineUpToCursor: string,
  isNoteName: (name: string) => boolean = () => true,
): { name: string; startIndex: number } | null {
  if (!lineUpToCursor.endsWith('@')) return null;
  const beforeAt = lineUpToCursor.slice(0, -1);

  const openBrackets = beforeAt.lastIndexOf('[[');
  if (openBrackets !== -1 && !beforeAt.slice(openBrackets).includes(']]')) {
    const name = beforeAt.slice(openBrackets + 2);
    // A pipe means the alias is being written, not the note name.
    if (name.includes('|') || name.includes('@')) return null;
    return name.length > 0 ? { name, startIndex: openBrackets } : null;
  }

  // Stopping at an existing @ keeps addresses like joao@gmail.com out of it.
  const run = /(?:^|[\s(>"'])([\w./\- ]+)$/.exec(beforeAt)?.[1];
  if (!run) return null;

  const words = run.split(' ').filter((word) => word.length > 0);
  for (let start = Math.max(0, words.length - MAX_NAME_WORDS); start < words.length; start += 1) {
    const name = words.slice(start).join(' ');
    if (isNoteName(name)) {
      return { name, startIndex: beforeAt.length - name.length };
    }
  }
  return null;
}

/**
 * Vaults holding a note whose name matches, most specific first.
 *
 * The current vault is never offered: a note there needs no cross-vault link.
 */
export function suggestionsFor(
  query: string,
  files: IndexedFile[],
  currentVaultId: string | null,
): CrossVaultSuggestion[] {
  const wanted = query.trim().toLowerCase();
  if (wanted.length === 0) return [];

  const matches = files.filter((file) =>
    file.vaultId !== currentVaultId &&
    file.extension.toLowerCase() === 'md' &&
    file.basename.toLowerCase() === wanted);

  const basenameCounts = new Map<string, number>();
  for (const file of matches) {
    const key = `${file.vaultId}:${file.basename.toLowerCase()}`;
    basenameCounts.set(key, (basenameCounts.get(key) ?? 0) + 1);
  }

  return matches.slice(0, MAX_SUGGESTIONS).map((file) => {
    const key = `${file.vaultId}:${file.basename.toLowerCase()}`;
    // A duplicated basename inside one vault has to be qualified by its path,
    // otherwise the link would be ambiguous the moment it is followed.
    const ambiguous = (basenameCounts.get(key) ?? 0) > 1;
    const pathReference = file.relativePath.replace(/\.md$/i, '');
    return {
      vaultName: file.vaultName,
      relativePath: file.relativePath,
      noteReference: ambiguous
        ? (pathReference.includes('/') ? pathReference : `/${pathReference}`)
        : file.basename,
    };
  });
}

/**
 * Completes `Name@` into a cross-vault link.
 *
 * Deliberately triggered by `@` rather than by `[[`: Obsidian's own link
 * suggester owns `[[`, and competing with it would need private API. Typing the
 * note name first also matches how people think of the note.
 */
export class CrossVaultSuggest extends EditorSuggest<CrossVaultSuggestion> {
  constructor(
    app: App,
    private readonly indexer: Indexer,
    private readonly vaultRegistry: VaultRegistry,
    private readonly linkFormat: () => CrossVaultLinkFormat | undefined,
  ) {
    super(app);
  }

  onTrigger(cursor: EditorPosition, editor: Editor, _file: TFile | null): EditorSuggestTriggerInfo | null {
    const lineUpToCursor = editor.getLine(cursor.line).slice(0, cursor.ch);
    const parsed = noteNameBeforeAt(
      lineUpToCursor,
      (name) => this.suggestionsForName(name).length > 0,
    );
    if (!parsed) return null;

    return {
      start: { line: cursor.line, ch: parsed.startIndex },
      end: cursor,
      query: parsed.name,
    };
  }

  getSuggestions(context: EditorSuggestContext): CrossVaultSuggestion[] {
    return this.suggestionsForName(context.query);
  }

  private suggestionsForName(name: string): CrossVaultSuggestion[] {
    return suggestionsFor(name, this.indexer.getIndexedFiles(), this.vaultRegistry.getCurrentVaultId());
  }

  renderSuggestion(suggestion: CrossVaultSuggestion, el: HTMLElement): void {
    el.createDiv({ text: `${suggestion.noteReference}@${suggestion.vaultName}` });
    el.createDiv({ cls: 'mvn-suggestion-path', text: suggestion.relativePath });
  }

  selectSuggestion(suggestion: CrossVaultSuggestion): void {
    const { context } = this;
    if (!context) return;

    const target = formatCrossVaultTarget(suggestion.vaultName, suggestion.noteReference, this.linkFormat());
    // Obsidian auto-closes [[, so swallow the brackets already sitting after the
    // caret instead of leaving [[Note@vault]]]] behind.
    const line = context.editor.getLine(context.end.line);
    const end = line.slice(context.end.ch, context.end.ch + 2) === ']]'
      ? { line: context.end.line, ch: context.end.ch + 2 }
      : context.end;

    context.editor.replaceRange(`[[${target}]]`, context.start, end);
    this.close();
  }
}
