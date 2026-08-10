import type { MigrationPlan } from './migration-types';

export interface MigrationIo {
  destinationExists(absolutePath: string): Promise<boolean>;
  readDestination(absolutePath: string): Promise<string>;
  writeDestination(absolutePath: string, content: string): Promise<void>;
  removeDestination(absolutePath: string): Promise<void>;
  readSourceFile(vaultPath: string): Promise<string>;
  writeSourceFile(vaultPath: string, content: string): Promise<void>;
  trashSourceFile(vaultPath: string): Promise<void>;
  restoreSourceFile(vaultPath: string, content: string): Promise<void>;
}

export interface MigrationExecutionResult {
  mode: MigrationPlan['mode'];
  outgoingLinksRewritten: number;
  backlinksRewritten: number;
}

export class DestinationExistsError extends Error {
  constructor(destination: string) {
    super(`Destination already exists: ${destination}`);
    this.name = 'DestinationExistsError';
  }
}

export class StaleMigrationPlanError extends Error {
  constructor(vaultPath: string) {
    super(`A file changed after migration review: ${vaultPath}`);
    this.name = 'StaleMigrationPlanError';
  }
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

export class MigrationExecutionError extends Error {
  readonly cause: Error;
  readonly rollbackErrors: Error[];

  constructor(cause: unknown, rollbackErrors: Error[]) {
    const original = asError(cause);
    const rollbackSummary = rollbackErrors.length > 0
      ? ` Rollback also failed: ${rollbackErrors.map((error) => error.message).join('; ')}`
      : '';
    super(`Cross-vault migration failed: ${original.message}.${rollbackSummary}`);
    this.name = 'MigrationExecutionError';
    this.cause = original;
    this.rollbackErrors = rollbackErrors;
  }
}

async function verifyUnchanged(
  io: MigrationIo,
  vaultPath: string,
  expected: string,
): Promise<void> {
  const current = await io.readSourceFile(vaultPath);
  if (current !== expected) throw new StaleMigrationPlanError(vaultPath);
}

export async function executeMigrationPlan(
  plan: MigrationPlan,
  io: MigrationIo,
): Promise<MigrationExecutionResult> {
  await verifyUnchanged(io, plan.sourcePath, plan.sourceOriginalContent);
  for (const edit of plan.backlinkEdits) {
    await verifyUnchanged(io, edit.path, edit.originalContent);
  }

  if (plan.destinationAbsolutePath && await io.destinationExists(plan.destinationAbsolutePath)) {
    throw new DestinationExistsError(plan.destinationAbsolutePath);
  }
  if (plan.destinationAbsolutePath && plan.destinationContent === null) {
    throw new Error('Destination content is missing from move/copy plan');
  }

  let destinationWritten = false;
  let sourceTrashAttempted = false;
  const attemptedBacklinks: typeof plan.backlinkEdits = [];
  try {
    if (plan.destinationAbsolutePath) {
      await io.writeDestination(plan.destinationAbsolutePath, plan.destinationContent!);
      destinationWritten = true;
    }

    for (const edit of plan.backlinkEdits) {
      attemptedBacklinks.push(edit);
      await io.writeSourceFile(edit.path, edit.updatedContent);
    }

    if (plan.mode === 'move') {
      sourceTrashAttempted = true;
      await io.trashSourceFile(plan.sourcePath);
    }
  } catch (error: unknown) {
    const rollbackErrors: Error[] = [];
    if (sourceTrashAttempted) {
      try {
        await io.readSourceFile(plan.sourcePath);
      } catch {
        try {
          await io.restoreSourceFile(plan.sourcePath, plan.sourceOriginalContent);
        } catch (rollbackError: unknown) {
          rollbackErrors.push(asError(rollbackError));
        }
      }
    }
    for (const edit of [...attemptedBacklinks].reverse()) {
      try {
        await io.writeSourceFile(edit.path, edit.originalContent);
      } catch (rollbackError: unknown) {
        rollbackErrors.push(asError(rollbackError));
      }
    }
    if (destinationWritten && plan.destinationAbsolutePath) {
      try {
        await io.removeDestination(plan.destinationAbsolutePath);
      } catch (rollbackError: unknown) {
        rollbackErrors.push(asError(rollbackError));
      }
    }
    throw new MigrationExecutionError(error, rollbackErrors);
  }

  return {
    mode: plan.mode,
    outgoingLinksRewritten: plan.outgoingLinksRewritten,
    backlinksRewritten: plan.backlinksRewritten,
  };
}
