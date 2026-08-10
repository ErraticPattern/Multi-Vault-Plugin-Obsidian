export function formatCrossVaultWikilink(vaultName: string, noteName: string): string {
  const vault = vaultName.trim();
  const note = noteName.trim();
  if (!vault || !note) throw new Error('Vault and note names are required');
  return `[[${vault}::${note}]]`;
}
