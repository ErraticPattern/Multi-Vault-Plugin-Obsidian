import type { CrossVaultLinkFormat } from '../cross-vault-syntax';
import type { App, TFile } from 'obsidian';
import type { Indexer } from '../indexer/indexer';
import type { VaultRegistry } from '../vault-registry';
import type { AvailableVaultConfig, IndexedFile } from '../types';
import { resolveDestinationPath } from './destination-paths';
import { collectMigrationSnapshot } from './obsidian-snapshot';
import { planMoveOrCopy, planStandaloneRelink } from './migration-planner';
import type { MigrationPlan } from './migration-types';
import { DestinationExistsError, executeMigrationPlan, type MigrationExecutionResult, type MigrationIo } from './migration-transaction';
import { ObsidianMigrationIo } from './obsidian-migration-io';
import { isMarkdownExtension } from './migration-view-models';
import {
  createMigrationPlanFingerprint,
  createTargetCatalogFingerprint,
  isMigrationPlanFingerprintCurrent,
  isTargetCatalogFingerprintCurrent,
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
    private readonly linkFormat: () => CrossVaultLinkFormat | undefined = () => undefined,
  ) {}

  private knownVaultNames(): string[] {
    return this.vaultRegistry.getVaults().map((vault) => vault.name);
  }

  async planMoveCopy(
    activeFile: TFile,
    targetVaultId: string,
    targetFolder: string,
    mode: 'move' | 'copy',
    preserveLinks: boolean,
    overwriteDestination = false,
  ): Promise<MigrationPlan> {
    const sourceVault = this.requireCurrentVault();
    const targetVault = this.requireVault(targetVaultId);
    const destination = resolveDestinationPath(targetVault.path, targetFolder, activeFile.name);
    const io = this.ioFactory();
    const destinationExists = await io.destinationExists(destination.absolutePath);
    if (destinationExists && !overwriteDestination) {
      throw new DestinationExistsError(destination.absolutePath);
    }
    const destinationOriginalContent = destinationExists
      ? await io.readDestination(destination.absolutePath)
      : null;
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
      linkFormat: this.linkFormat(),
      knownVaultNames: this.knownVaultNames(),
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
    return this.withMetadata(
      activeFile,
      {
        ...plan,
        destinationPolicy: destinationExists && overwriteDestination ? 'overwrite-reviewed' : 'create-only',
        destinationOriginalContent,
      },
      indexMutations,
      targetVault.id,
      destination.relativePath,
    );
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
      linkFormat: this.linkFormat(),
    });
    const sourceVault = this.requireCurrentVault();
    const indexMutations: IndexMutation[] = plan.backlinkEdits.map((edit) => ({
      kind: 'upsert',
      vaultId: sourceVault.id,
      relativePath: edit.path,
    }));
    return this.withMetadata(
      activeFile,
      plan,
      indexMutations,
      targetVault.id,
      targetRelativePath,
    );
  }

  isPlanCurrent(plan: MigrationPlan, activeFile: TFile): boolean {
    if (!plan.fingerprint || !isMigrationPlanFingerprintCurrent(
      plan.fingerprint,
      activeFile.path,
      activeFile.stat?.mtime ?? 0,
      this.app.metadataCache.resolvedLinks,
    )) return false;
    const target = plan.fingerprint.target;
    if (!target) return true;
    if (!this.vaultRegistry.getVaultById(target.vaultId)) return false;
    return isTargetCatalogFingerprintCurrent(
      target,
      this.indexedMarkdownFiles(target.vaultId),
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
    targetVaultId: string,
    targetRelativePath: string,
  ): MigrationPlan {
    return {
      ...plan,
      indexMutations,
      fingerprint: {
        ...createMigrationPlanFingerprint(
          activeFile.path,
          activeFile.stat?.mtime ?? 0,
          this.app.metadataCache.resolvedLinks,
        ),
        target: createTargetCatalogFingerprint(
          targetVaultId,
          targetRelativePath,
          this.indexedMarkdownFiles(targetVaultId),
        ),
      },
    };
  }

  private indexedMarkdownFiles(vaultId: string): IndexedFile[] {
    return this.indexer.getIndexedFiles().filter((file) =>
      file.vaultId === vaultId && isMarkdownExtension(file.extension));
  }

  private requireCurrentVault(): AvailableVaultConfig {
    const id = this.vaultRegistry.getCurrentVaultId();
    if (!id) throw new Error('Current vault is not configured');
    return this.requireVault(id);
  }

  private requireVault(id: string): AvailableVaultConfig {
    const vault = this.vaultRegistry.getVaultById(id);
    if (!vault || vault.available === false) throw new Error(`Vault is unavailable: ${id}`);
    return vault;
  }
}
