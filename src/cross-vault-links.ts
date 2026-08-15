import { Editor, EditorPosition, MarkdownView, Notice } from 'obsidian';
import type MultiVaultNavigatorPlugin from './main';
import type { IndexedFile } from './types';
import { resolveIndexedNote } from './note-resolution';
import { CrossVaultTargetSuggestModal } from './modals/cross-vault-target-suggest-modal';
import { parseCrossVaultTarget, type CrossVaultRef } from './cross-vault-syntax';

/**
 * `Note@vault` is only a cross-vault link when the suffix names a configured
 * vault, so parsing always needs the registry to decide.
 */
function parseWithRegistry(plugin: MultiVaultNavigatorPlugin, target: string): CrossVaultRef | null {
  return parseCrossVaultTarget(target, (vaultName) =>
    plugin.vaultRegistry.getVaults().some(vault => vault.name.toLowerCase() === vaultName.toLowerCase()),
  );
}

// posAtMouse/getClickableTokenAt exist on Obsidian's editor at runtime but are
// not part of the public typings. Feature-detected before use.
interface EditorTokenApi {
  posAtMouse?(evt: MouseEvent): EditorPosition;
  getClickableTokenAt?(pos: EditorPosition): { type: string; text: string } | null;
}

export type { CrossVaultRef } from './cross-vault-syntax';

function withCrossVaultTarget(
  plugin: MultiVaultNavigatorPlugin,
  ref: CrossVaultRef,
  onResolved: (target: IndexedFile) => void,
): void {
  const resolution = resolveIndexedNote(
    plugin.indexer.getIndexedFiles(),
    ref.vaultName,
    ref.noteName,
  );
  if (resolution.kind === 'resolved') {
    onResolved(resolution.target);
  } else if (resolution.kind === 'ambiguous') {
    new CrossVaultTargetSuggestModal(plugin.app, resolution.candidates, onResolved).open();
  } else {
    new Notice(`File "${ref.noteName}" not found in vault "${ref.vaultName}".`);
  }
}

function openCrossVaultRef(plugin: MultiVaultNavigatorPlugin, ref: CrossVaultRef): void {
  withCrossVaultTarget(plugin, ref, (target) => {
    void plugin.fileOpener.openFile(target);
  });
}

function rewriteReadingViewAnchor(plugin: MultiVaultNavigatorPlugin, anchor: HTMLAnchorElement, ref: CrossVaultRef, href: string): void {
  const rawText = (anchor.textContent ?? '').trim();
  const label = rawText && rawText !== href ? rawText : ref.noteName;

  anchor.empty();
  // Detach from core link handling: no internal-link class, no data-href, so
  // core's delegated click/hover handlers ignore this anchor entirely.
  anchor.removeClass('internal-link');
  anchor.removeClass('is-unresolved');
  anchor.addClass('mvn-cross-vault-link');
  anchor.removeAttribute('data-href');
  anchor.removeAttribute('href');
  if (plugin.settings.showCrossVaultBadge !== false) {
    anchor.createSpan({ cls: 'mvn-vault-badge', text: ref.vaultName });
  }
  anchor.appendText(label);
  if (plugin.settings.useVaultColorForLinks) {
    const vaultColor = plugin.vaultRegistry
      .getVaults()
      .find(v => v.name.toLowerCase() === ref.vaultName.toLowerCase())?.color;
    if (vaultColor) {
      anchor.addClass('mvn-vault-colored');
      anchor.style.setProperty('--mvn-vault-color', vaultColor);
    }
  }

  anchor.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    openCrossVaultRef(plugin, ref);
  });

  anchor.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    e.stopPropagation();
    withCrossVaultTarget(plugin, ref, (target) => {
      window.open(`obsidian://open?vault=${encodeURIComponent(target.vaultName)}&file=${encodeURIComponent(target.relativePath)}`);
    });
  });
}

function findMarkdownViewContaining(plugin: MultiVaultNavigatorPlugin, el: HTMLElement): MarkdownView | null {
  let found: MarkdownView | null = null;
  plugin.app.workspace.iterateAllLeaves((leaf) => {
    if (!found && leaf.view instanceof MarkdownView && leaf.view.containerEl.contains(el)) {
      found = leaf.view;
    }
  });
  return found;
}

export function registerCrossVaultLinks(plugin: MultiVaultNavigatorPlugin): void {
  // Reading View: core has already parsed [[vault::note]] into an unresolved
  // internal-link anchor by the time postprocessors run. Rewrite those anchors.
  plugin.registerMarkdownPostProcessor((element) => {
    const anchors = Array.from(element.querySelectorAll<HTMLAnchorElement>('a.internal-link'));
    for (const anchor of anchors) {
      const href = anchor.getAttribute('data-href') ?? anchor.getAttribute('href') ?? '';
      const ref = parseWithRegistry(plugin, href);
      if (!ref) continue;
      rewriteReadingViewAnchor(plugin, anchor, ref, href);
    }
  });

  // Live Preview / source mode: core renders the wikilink inside CodeMirror and
  // would treat a click as "create note". Capture-phase listener wins the race,
  // resolves the clicked token, and intercepts only vault::note targets.
  plugin.registerDomEvent(document, 'click', (evt: MouseEvent) => {
    if (evt.button !== 0) return;
    const target = evt.target;
    if (!(target instanceof HTMLElement)) return;
    if (!target.closest('.cm-content')) return;
    const mdView = findMarkdownViewContaining(plugin, target);
    if (!mdView) return;
    const editor = mdView.editor as Editor & EditorTokenApi;
    if (typeof editor.posAtMouse !== 'function' || typeof editor.getClickableTokenAt !== 'function') return;
    const token = editor.getClickableTokenAt(editor.posAtMouse(evt));
    if (!token || token.type !== 'internal-link') return;
    const ref = parseWithRegistry(plugin, token.text);
    if (!ref) return;
    evt.preventDefault();
    evt.stopPropagation();
    openCrossVaultRef(plugin, ref);
  }, { capture: true });
}
