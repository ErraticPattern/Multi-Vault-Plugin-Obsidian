export interface IndexMutation {
  kind: 'upsert' | 'remove';
  vaultId: string;
  relativePath: string;
}

export function deduplicateMutations(mutations: IndexMutation[]): IndexMutation[] {
  const byIdentity = new Map<string, IndexMutation>();
  for (const mutation of mutations) {
    const relativePath = mutation.relativePath.replace(/\\/g, '/');
    byIdentity.set(`${mutation.vaultId}:${relativePath.toLowerCase()}`, {
      ...mutation,
      relativePath,
    });
  }
  return [...byIdentity.values()];
}
