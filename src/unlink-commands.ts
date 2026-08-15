import { MarkdownView, Notice, Plugin, TFile } from 'obsidian';

import { removeCrossVaultLinks } from './unlink-cross-vault';
import { UnlinkConfirmModal } from './modals/unlink-confirm-modal';

export const UNLINK_CURRENT_NOTE_COMMAND_ID = 'multi-vault-unlink-current-note';
export const UNLINK_ALL_NOTES_COMMAND_ID = 'multi-vault-unlink-all-notes';

/** Minimal surface of the app this needs, so the planning half stays testable. */
export interface UnlinkIo {
  markdownFiles(): TFile[];
  read(file: TFile): Promise<string>;
  /** Writes only if the file still holds `expected`, so a concurrent edit wins. */
  write(file: TFile, expected: string, next: string): Promise<boolean>;
}

export interface PlannedUnlink {
  file: TFile;
  sourceText: string;
  text: string;
  removed: number;
}

export interface UnlinkPlan {
  notes: PlannedUnlink[];
  totalLinks: number;
}

export async function planUnlink(
  io: UnlinkIo,
  files: readonly TFile[],
  isKnownVault: (vaultName: string) => boolean,
): Promise<UnlinkPlan> {
  const notes: PlannedUnlink[] = [];

  for (const file of files) {
    const sourceText = await io.read(file);
    // Cheap rejection: no `[[` and no `@`/`::` means nothing here can match.
    if (!sourceText.includes('[[')) continue;

    const result = removeCrossVaultLinks(sourceText, isKnownVault);
    if (result.removed === 0) continue;
    notes.push({ file, sourceText, text: result.text, removed: result.removed });
  }

  return {
    notes,
    totalLinks: notes.reduce((total, note) => total + note.removed, 0),
  };
}

export async function applyUnlink(
  io: UnlinkIo,
  plan: UnlinkPlan,
): Promise<{ written: number; skipped: number }> {
  let written = 0;
  let skipped = 0;
  for (const note of plan.notes) {
    if (await io.write(note.file, note.sourceText, note.text)) written += 1;
    else skipped += 1;
  }
  return { written, skipped };
}

function describe(links: number, notes: number): string {
  return `${links} cross-vault ${links === 1 ? 'link' : 'links'} in ${notes} ${notes === 1 ? 'note' : 'notes'}`;
}

export interface UnlinkCommandDeps {
  isKnownVault: () => (vaultName: string) => boolean;
}

export function registerUnlinkCommands(plugin: Plugin, deps: UnlinkCommandDeps): void {
  const io: UnlinkIo = {
    markdownFiles: () => plugin.app.vault.getMarkdownFiles(),
    read: (file) => plugin.app.vault.read(file),
    write: async (file, expected, next) => {
      let wrote = false;
      await plugin.app.vault.process(file, (data) => {
        if (data !== expected) return data;
        wrote = true;
        return next;
      });
      return wrote;
    },
  };

  plugin.addCommand({
    id: UNLINK_CURRENT_NOTE_COMMAND_ID,
    name: 'Remove cross-vault links in current note',
    checkCallback: (checking: boolean) => {
      const file = plugin.app.workspace.getActiveFile();
      if (!file || file.extension !== 'md') return false;
      if (checking) return true;

      void (async () => {
        const plan = await planUnlink(io, [file], deps.isKnownVault());
        if (plan.notes.length === 0) {
          new Notice('No cross-vault links in this note.');
          return;
        }

        const note = plan.notes[0];
        // Rewriting through the editor keeps the change on the undo stack, which
        // matters most for the note someone is looking at.
        const view = plugin.app.workspace.getActiveViewOfType(MarkdownView);
        if (view?.file === file && view.editor.getValue() === note.sourceText) {
          const cursor = view.editor.getCursor();
          view.editor.setValue(note.text);
          view.editor.setCursor(cursor);
        } else if (!(await io.write(file, note.sourceText, note.text))) {
          new Notice('Note changed while it was being read. Nothing was rewritten; try again.');
          return;
        }
        new Notice(`Removed ${describe(note.removed, 1)}.`);
      })();

      return true;
    },
  });

  plugin.addCommand({
    id: UNLINK_ALL_NOTES_COMMAND_ID,
    name: 'Remove cross-vault links in all notes',
    callback: () => {
      void (async () => {
        const plan = await planUnlink(io, io.markdownFiles(), deps.isKnownVault());
        if (plan.notes.length === 0) {
          new Notice('No cross-vault links in this vault.');
          return;
        }

        new UnlinkConfirmModal(
          plugin.app,
          plan,
          async () => {
            const { written, skipped } = await applyUnlink(io, plan);
            const tail = skipped > 0 ? ` ${skipped} note(s) changed meanwhile and were left alone.` : '';
            new Notice(`Removed ${describe(plan.totalLinks, written)}.${tail}`);
          },
        ).open();
      })();
    },
  });
}
