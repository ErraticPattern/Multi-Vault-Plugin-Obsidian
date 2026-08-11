import type { MigrationPlan } from './migration-types';

const destinationOwnershipBrand: unique symbol = Symbol('destination-ownership');

/** Opaque proof that one MigrationIo instance successfully published a destination. */
export interface DestinationOwnershipToken {
  readonly [destinationOwnershipBrand]: true;
}

export interface MigrationIo {
  destinationExists(absolutePath: string): Promise<boolean>;
  readDestination(absolutePath: string): Promise<string>;
  writeDestination(
    absolutePath: string,
    content: string,
    expectedOriginal: string | null,
  ): Promise<DestinationOwnershipToken>;
  restoreDestination(
    absolutePath: string,
    ownership: DestinationOwnershipToken,
  ): Promise<void>;
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

export class DestinationOwnershipError extends Error {
  constructor(destination: string) {
    super(`Destination changed unexpectedly during rollback: ${destination}`);
    this.name = 'DestinationOwnershipError';
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

async function verifyDestination(io: MigrationIo, plan: MigrationPlan): Promise<string | null> {
  if (!plan.destinationAbsolutePath) return null;

  const original = plan.destinationOriginalContent ?? null;
  const policy = plan.destinationPolicy ?? 'create-only';
  const exists = await io.destinationExists(plan.destinationAbsolutePath);
  if (policy === 'create-only' && exists) {
    throw new DestinationExistsError(plan.destinationAbsolutePath);
  }
  if (policy === 'overwrite-reviewed') {
    if (!exists || await io.readDestination(plan.destinationAbsolutePath) !== original) {
      throw new StaleMigrationPlanError(plan.destinationAbsolutePath);
    }
  }
  if (plan.destinationContent === null) {
    throw new Error('Destination content is missing from move/copy plan');
  }
  return original;
}

export async function executeMigrationPlan(
  plan: MigrationPlan,
  io: MigrationIo,
): Promise<MigrationExecutionResult> {
  await verifyUnchanged(io, plan.sourcePath, plan.sourceOriginalContent);
  for (const edit of plan.backlinkEdits) {
    await verifyUnchanged(io, edit.path, edit.originalContent);
  }

  const destinationOriginal = await verifyDestination(io, plan);

  let destinationOwnership: DestinationOwnershipToken | null = null;
  let sourceTrashAttempted = false;
  const attemptedBacklinks: typeof plan.backlinkEdits = [];
  try {
    if (plan.destinationAbsolutePath) {
      const policy = plan.destinationPolicy ?? 'create-only';
      destinationOwnership = await io.writeDestination(
        plan.destinationAbsolutePath,
        plan.destinationContent!,
        policy === 'overwrite-reviewed' ? destinationOriginal : null,
      );
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
    if (destinationOwnership && plan.destinationAbsolutePath) {
      try {
        await io.restoreDestination(
          plan.destinationAbsolutePath,
          destinationOwnership,
        );
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
