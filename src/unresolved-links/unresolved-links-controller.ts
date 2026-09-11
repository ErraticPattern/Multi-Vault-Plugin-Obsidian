import { App, TFile } from 'obsidian';
import type { CrossVaultLinkFormat } from '../cross-vault-syntax';
import type { Indexer } from '../indexer/indexer';
import type { VaultRegistry } from '../vault-registry';
import { buildUnresolvedLinkPlan, createProposalEdits, type UnresolvedLinkPlan } from './unresolved-link-planner';
import { executeUnresolvedLinkEdits, type UnresolvedLinkTransactionResult } from './unresolved-link-transaction';
import type { SelectedResolution } from './unresolved-links-view-model';

export class UnresolvedLinksController {
  constructor(
    private readonly app: App,
    private readonly indexer: Indexer,
    private readonly vaultRegistry: VaultRegistry,
    private readonly getFormat: () => CrossVaultLinkFormat,
  ) {}

  async scan(): Promise<UnresolvedLinkPlan> {
    const currentVaultId = this.vaultRegistry.getCurrentVaultId();
    if (!currentVaultId) throw new Error('The current vault is not configured in MVN.');
    const sources = await Promise.all(this.app.vault.getMarkdownFiles().map(async file => ({
      path: file.path,
      content: await this.app.vault.read(file),
    })));
    const availableIds = new Set(this.vaultRegistry.getVaults()
      .filter(vault => vault.enabled && vault.available !== false)
      .map(vault => vault.id));
    const files = this.indexer.getIndexedFiles().filter(file => availableIds.has(file.vaultId));
    return buildUnresolvedLinkPlan(sources, files, {
      currentVaultId,
      isResolvedLocally: (sourcePath, linkpath) =>
        this.app.metadataCache.getFirstLinkpathDest(linkpath, sourcePath) !== null,
    });
  }

  async apply(plan: UnresolvedLinkPlan, selections: SelectedResolution[]): Promise<UnresolvedLinkTransactionResult> {
    const edits = selections.flatMap(selection => {
      const group = plan.groups.find(item => item.id === selection.groupId);
      const candidate = group?.candidates.find(item => item.id === selection.candidateId);
      return group && candidate ? createProposalEdits(group, candidate, this.getFormat(), plan.files) : [];
    });
    const result = await executeUnresolvedLinkEdits(edits, {
      read: async sourcePath => {
        const file = this.app.vault.getAbstractFileByPath(sourcePath);
        if (!(file instanceof TFile)) throw new Error(`Source note no longer exists: ${sourcePath}`);
        return this.app.vault.read(file);
      },
      write: async (sourcePath, content) => {
        const file = this.app.vault.getAbstractFileByPath(sourcePath);
        if (!(file instanceof TFile)) throw new Error(`Source note no longer exists: ${sourcePath}`);
        await this.app.vault.modify(file, content);
      },
    });
    if (result.changedPaths.length > 0) {
      const currentVaultId = this.vaultRegistry.getCurrentVaultId();
      if (currentVaultId) await this.indexer.applyMutations(result.changedPaths.map(relativePath => ({
        kind: 'upsert' as const, vaultId: currentVaultId, relativePath,
      })));
    }
    return result;
  }
}
