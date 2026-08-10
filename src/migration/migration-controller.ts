import type { App, TFile } from 'obsidian';
import type { Indexer } from '../indexer/indexer';
import type { VaultRegistry } from '../vault-registry';
import type { IndexedFile, VaultConfig } from '../types';
import { resolveDestinationPath } from './destination-paths';
import { collectSourceVaultSnapshot } from './obsidian-snapshot';
import { planMoveOrCopy, planStandaloneRelink } from './migration-planner';
import type { MigrationPlan } from './migration-types';
import { executeMigrationPlan, type MigrationExecutionResult, type MigrationIo } from './migration-transaction';
import { ObsidianMigrationIo } from './obsidian-migration-io';

export type MigrationIoFactory = () => MigrationIo;

export class MigrationController {
  constructor(
    private readonly app: App,
    private readonly vaultRegistry: VaultRegistry,
    private readonly indexer: Indexer,
    private readonly ioFactory: MigrationIoFactory = () => new ObsidianMigrationIo(app),
  ) {}

  async planMoveCopy(
    activeFile: TFile,
    targetVaultId: string,
    targetFolder: string,
    mode: 'move' | 'copy',
    preserveLinks: boolean,
  ): Promise<MigrationPlan> {
    const sourceVault = this.requireCurrentVault();
    const targetVault = this.requireVault(targetVaultId);
    const destination = resolveDestinationPath(targetVault.path, targetFolder, activeFile.name);
    const notes = await collectSourceVaultSnapshot(this.app);
    return planMoveOrCopy({
      mode,
      sourcePath: activeFile.path,
      sourceVaultName: sourceVault.name,
      targetVaultName: targetVault.name,
      destinationAbsolutePath: destination.absolutePath,
      destinationRelativePath: destination.relativePath,
      notes,
      sourceIndexedFiles: this.indexedMarkdownFiles(sourceVault.id),
      targetIndexedFiles: this.indexedMarkdownFiles(targetVault.id),
      preserveLinks,
    });
  }

  async planRelink(
    activeFile: TFile,
    targetVaultId: string,
    targetNote: IndexedFile,
  ): Promise<MigrationPlan> {
    const targetVault = this.requireVault(targetVaultId);
    if (targetNote.vaultId !== targetVault.id || targetNote.extension.toLowerCase() !== 'md') {
      throw new Error('Selected target note is not a Markdown note in the target vault');
    }
    const notes = await collectSourceVaultSnapshot(this.app);
    return planStandaloneRelink({
      sourcePath: activeFile.path,
      targetVaultName: targetVault.name,
      targetRelativePath: targetNote.relativePath,
      notes,
      targetIndexedFiles: this.indexedMarkdownFiles(targetVault.id),
    });
  }

  async execute(plan: MigrationPlan): Promise<MigrationExecutionResult> {
    const result = await executeMigrationPlan(plan, this.ioFactory());
    await this.indexer.buildFullIndex(true);
    return result;
  }

  private indexedMarkdownFiles(vaultId: string): IndexedFile[] {
    return this.indexer.getIndexedFiles().filter((file) =>
      file.vaultId === vaultId && file.extension.toLowerCase() === 'md');
  }

  private requireCurrentVault(): VaultConfig {
    const id = this.vaultRegistry.getCurrentVaultId();
    if (!id) throw new Error('Current vault is not configured');
    return this.requireVault(id);
  }

  private requireVault(id: string): VaultConfig {
    const vault = this.vaultRegistry.getVaultById(id);
    if (!vault) throw new Error(`Vault is not configured: ${id}`);
    return vault;
  }
}
