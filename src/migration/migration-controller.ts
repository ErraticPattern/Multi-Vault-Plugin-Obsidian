import type { App, TFile } from 'obsidian';
import type { Indexer } from '../indexer/indexer';
import type { VaultRegistry } from '../vault-registry';
import type { IndexedFile, VaultConfig } from '../types';
import { resolveDestinationPath } from './destination-paths';
import { collectMigrationSnapshot } from './obsidian-snapshot';
import { planMoveOrCopy, planStandaloneRelink } from './migration-planner';
import type { MigrationPlan } from './migration-types';
import { executeMigrationPlan, type MigrationExecutionResult, type MigrationIo } from './migration-transaction';
import { ObsidianMigrationIo } from './obsidian-migration-io';
import { isMarkdownExtension } from './migration-view-models';
import {
  createMigrationPlanFingerprint,
  isMigrationPlanFingerprintCurrent,
} from './prepared-plan-cache';
import type { IndexMutation } from '../indexer/index-mutations';

export type MigrationIoFactory = () => MigrationIo;

export interface MigrationControllerExecutionResult extends MigrationExecutionResult {
  indexUpdated: boolean;
  indexError?: string;
}

export function resolveRelinkTargetRelativePath(
  sourceBasename: string,
  targetFiles: IndexedFile[],
  selectedTarget?: IndexedFile,
): string {
  if (selectedTarget) return selectedTarget.relativePath;
  const matches = targetFiles.filter((file) =>
    isMarkdownExtension(file.extension) &&
    file.basename.toLowerCase() === sourceBasename.toLowerCase());
  if (matches.length === 1) return matches[0].relativePath;
  if (matches.length > 1) {
    throw new Error(`Multiple destination notes named "${sourceBasename}" exist; choose one explicitly.`);
  }
  return `${sourceBasename}.md`;
}

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
    const notes = await collectMigrationSnapshot(this.app, activeFile.path);
    const plan = planMoveOrCopy({
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
    const indexMutations: IndexMutation[] = [
      ...(mode === 'move' ? [{
        kind: 'remove' as const,
        vaultId: sourceVault.id,
        relativePath: activeFile.path,
      }] : []),
      {
        kind: 'upsert',
        vaultId: targetVault.id,
        relativePath: destination.relativePath,
      },
      ...(mode === 'move' ? plan.backlinkEdits.map((edit) => ({
        kind: 'upsert' as const,
        vaultId: sourceVault.id,
        relativePath: edit.path,
      })) : []),
    ];
    return this.withMetadata(activeFile, plan, indexMutations);
  }

  async planRelink(
    activeFile: TFile,
    targetVaultId: string,
    targetNote?: IndexedFile,
  ): Promise<MigrationPlan> {
    const targetVault = this.requireVault(targetVaultId);
    if (targetNote && (targetNote.vaultId !== targetVault.id || !isMarkdownExtension(targetNote.extension))) {
      throw new Error('Selected target note is not a Markdown note in the target vault');
    }
    const targetIndexedFiles = this.indexedMarkdownFiles(targetVault.id);
    const targetRelativePath = resolveRelinkTargetRelativePath(
      activeFile.basename,
      targetIndexedFiles,
      targetNote,
    );
    const notes = await collectMigrationSnapshot(this.app, activeFile.path);
    const plan = planStandaloneRelink({
      sourcePath: activeFile.path,
      targetVaultName: targetVault.name,
      targetRelativePath,
      notes,
      targetIndexedFiles,
    });
    const sourceVault = this.requireCurrentVault();
    const indexMutations: IndexMutation[] = plan.backlinkEdits.map((edit) => ({
      kind: 'upsert',
      vaultId: sourceVault.id,
      relativePath: edit.path,
    }));
    return this.withMetadata(activeFile, plan, indexMutations);
  }

  isPlanCurrent(plan: MigrationPlan, activeFile: TFile): boolean {
    return Boolean(plan.fingerprint) && isMigrationPlanFingerprintCurrent(
      plan.fingerprint!,
      activeFile.path,
      activeFile.stat?.mtime ?? 0,
      this.app.metadataCache.resolvedLinks,
    );
  }

  async execute(plan: MigrationPlan): Promise<MigrationControllerExecutionResult> {
    const result = await executeMigrationPlan(plan, this.ioFactory());
    try {
      await this.indexer.applyMutations(plan.indexMutations ?? []);
      return { ...result, indexUpdated: true };
    } catch (error: unknown) {
      return {
        ...result,
        indexUpdated: false,
        indexError: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private withMetadata(
    activeFile: TFile,
    plan: MigrationPlan,
    indexMutations: IndexMutation[],
  ): MigrationPlan {
    return {
      ...plan,
      indexMutations,
      fingerprint: createMigrationPlanFingerprint(
        activeFile.path,
        activeFile.stat?.mtime ?? 0,
        this.app.metadataCache.resolvedLinks,
      ),
    };
  }

  private indexedMarkdownFiles(vaultId: string): IndexedFile[] {
    return this.indexer.getIndexedFiles().filter((file) =>
      file.vaultId === vaultId && isMarkdownExtension(file.extension));
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
