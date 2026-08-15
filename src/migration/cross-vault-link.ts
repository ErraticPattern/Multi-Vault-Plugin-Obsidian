import {
  DEFAULT_CROSS_VAULT_LINK_FORMAT,
  formatCrossVaultTarget,
  type CrossVaultLinkFormat,
} from '../cross-vault-syntax';

export function formatCrossVaultWikilink(
  vaultName: string,
  noteName: string,
  format: CrossVaultLinkFormat = DEFAULT_CROSS_VAULT_LINK_FORMAT,
): string {
  return `[[${formatCrossVaultTarget(vaultName, noteName, format)}]]`;
}
