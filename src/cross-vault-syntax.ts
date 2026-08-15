/**
 * Both spellings of a cross-vault link.
 *
 * `Note@vault` reads better in a sentence and, more importantly, starts with the
 * note name, so Obsidian's own note-name matching and this plugin's suggester
 * both work from the first character typed. `vault::Note` is the original form
 * and stays readable forever; only the form that gets *written* is a choice.
 */
export type CrossVaultLinkFormat = 'note-at-vault' | 'vault-double-colon';

export const DEFAULT_CROSS_VAULT_LINK_FORMAT: CrossVaultLinkFormat = 'note-at-vault';

export interface CrossVaultRef {
  vaultName: string;
  noteName: string;
}

/** Splits "Note#Heading" into its parts. Cross-vault subpaths always come last. */
function splitSubpath(target: string): { body: string; subpath: string } {
  const hash = target.indexOf('#');
  return hash === -1
    ? { body: target, subpath: '' }
    : { body: target.slice(0, hash), subpath: target.slice(hash) };
}

/**
 * Parses a wikilink target into a cross-vault reference, or null when it is an
 * ordinary link.
 *
 * `vault::note` is unambiguous. `note@vault` is only accepted when the text
 * after the last `@` names a vault that actually exists, because note names,
 * addresses and handles contain `@` too and must keep working as plain links.
 */
export function parseCrossVaultTarget(
  target: string,
  isKnownVault: (vaultName: string) => boolean = () => false,
): CrossVaultRef | null {
  if (!target) return null;

  const colon = target.indexOf('::');
  if (colon > 0) {
    const vaultName = target.slice(0, colon).trim();
    const noteName = splitSubpath(target.slice(colon + 2)).body.trim();
    return vaultName && noteName ? { vaultName, noteName } : null;
  }

  const { body } = splitSubpath(target);
  const at = body.lastIndexOf('@');
  if (at <= 0) return null;

  const vaultName = body.slice(at + 1).trim();
  const noteName = body.slice(0, at).trim();
  if (!vaultName || !noteName) return null;
  return isKnownVault(vaultName) ? { vaultName, noteName } : null;
}

/** Writes a link target in the requested format. Subpaths are appended by the caller. */
export function formatCrossVaultTarget(
  vaultName: string,
  notePath: string,
  format: CrossVaultLinkFormat = DEFAULT_CROSS_VAULT_LINK_FORMAT,
): string {
  const vault = vaultName.trim();
  const note = notePath.trim();
  if (!vault || !note) throw new Error('Vault and note names are required');
  return format === 'vault-double-colon' ? `${vault}::${note}` : `${note}@${vault}`;
}

/**
 * True when a link already points at another vault, in either spelling, so it
 * is never rewritten a second time.
 */
export function isCrossVaultTarget(
  target: string,
  isKnownVault: (vaultName: string) => boolean = () => false,
): boolean {
  return parseCrossVaultTarget(target, isKnownVault) !== null;
}
