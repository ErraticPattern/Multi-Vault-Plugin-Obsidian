import { describe, expect, it } from 'vitest';
import {
  DestinationExistsError,
  DestinationOwnershipError,
  executeMigrationPlan,
  MigrationExecutionError,
  StaleMigrationPlanError,
  type DestinationOwnershipToken,
  type MigrationIo,
} from '../src/migration/migration-transaction';
import type { MigrationPlan } from '../src/migration/migration-types';

class MemoryIo implements MigrationIo {
  source = new Map<string, string>();
  destination = new Map<string, string>();
  log: string[] = [];
  failDestinationWrite = false;
  failDestinationAfterPublishingPlannedContent = false;
  failSourceWriteAt: number | null = null;
  failTrash = false;
  failTrashAfterDelete = false;
  failRollbackPath: string | null = null;
  concurrentDestinationWrite: string | null = null;
  private sourceWriteCount = 0;

  async destinationExists(absolutePath: string): Promise<boolean> {
    this.log.push('check-destination');
    return this.destination.has(absolutePath);
  }
  async readDestination(absolutePath: string): Promise<string> {
    return this.destination.get(absolutePath) ?? '';
  }
  async writeDestination(
    absolutePath: string,
    content: string,
    expectedOriginal: string | null,
  ): Promise<DestinationOwnershipToken> {
    this.log.push('write-destination');
    const failedContent = this.failDestinationAfterPublishingPlannedContent
      ? content
      : 'concurrent destination';
    this.destination.set(absolutePath, this.failDestinationWrite ? failedContent : content);
    if (this.failDestinationWrite) throw new Error('destination write failed');
    return { absolutePath, writtenContent: content, originalContent: expectedOriginal } as unknown as DestinationOwnershipToken;
  }
  async restoreDestination(
    absolutePath: string,
    ownership: DestinationOwnershipToken,
  ): Promise<void> {
    this.log.push('restore-destination');
    const token = ownership as unknown as {
      absolutePath: string;
      writtenContent: string;
      originalContent: string | null;
    };
    if (token.absolutePath !== absolutePath || this.destination.get(absolutePath) !== token.writtenContent) {
      throw new DestinationOwnershipError(absolutePath);
    }
    if (token.originalContent === null) {
      this.destination.delete(absolutePath);
    } else {
      this.destination.set(absolutePath, token.originalContent);
    }
  }
  async readSourceFile(vaultPath: string): Promise<string> {
    this.log.push(`check-stale:${vaultPath}`);
    const value = this.source.get(vaultPath);
    if (value === undefined) throw new Error(`Missing source: ${vaultPath}`);
    return value;
  }
  async writeSourceFile(vaultPath: string, content: string): Promise<void> {
    this.log.push(`write-backlink:${vaultPath}`);
    this.sourceWriteCount += 1;
    if (this.failRollbackPath === vaultPath && content.includes('[[Zerotier]]')) {
      throw new Error(`rollback failed: ${vaultPath}`);
    }
    this.source.set(vaultPath, content);
    if (this.failSourceWriteAt === this.sourceWriteCount) {
      if (this.concurrentDestinationWrite !== null) {
        for (const key of this.destination.keys()) {
          this.destination.set(key, this.concurrentDestinationWrite);
        }
      }
      throw new Error('backlink write failed');
    }
  }
  async trashSourceFile(vaultPath: string): Promise<void> {
    this.log.push(`trash-source:${vaultPath}`);
    if (this.failTrash) throw new Error('trash failed');
    this.source.delete(vaultPath);
    if (this.failTrashAfterDelete) throw new Error('trash reported failure after delete');
  }
  async restoreSourceFile(vaultPath: string, content: string): Promise<void> {
    this.log.push(`restore-source:${vaultPath}`);
    this.source.set(vaultPath, content);
  }
}

function plan(mode: MigrationPlan['mode']): MigrationPlan {
  return {
    mode,
    sourcePath: 'Projects/Zerotier.md',
    sourceOriginalContent: 'Uses [[EEG]].',
    destinationAbsolutePath: mode === 'relink' ? null : 'C:/target/Notes/Zerotier.md',
    destinationRelativePath: mode === 'relink' ? null : 'Notes/Zerotier.md',
    destinationContent: mode === 'relink' ? null : 'Uses [[ideas::EEG]].',
    backlinkEdits: mode === 'copy' ? [] : [{
      path: 'Notes/Index.md',
      originalContent: 'See [[Zerotier]].',
      updatedContent: 'See [[mathematics::Zerotier]].',
      rewrittenLinks: 1,
    }],
    outgoingLinksRewritten: mode === 'relink' ? 0 : 1,
    backlinksRewritten: mode === 'copy' ? 0 : 1,
    skipped: [],
  };
}

function readyIo(): MemoryIo {
  const io = new MemoryIo();
  io.source.set('Projects/Zerotier.md', 'Uses [[EEG]].');
  io.source.set('Notes/Index.md', 'See [[Zerotier]].');
  return io;
}

describe('executeMigrationPlan successful operations', () => {
  it('writes destination, backlinks, and trashes source in safe order for move', async () => {
    const io = readyIo();

    await executeMigrationPlan(plan('move'), io);

    expect(io.log).toEqual([
      'check-stale:Projects/Zerotier.md',
      'check-stale:Notes/Index.md',
      'check-destination',
      'write-destination',
      'write-backlink:Notes/Index.md',
      'trash-source:Projects/Zerotier.md',
    ]);
    expect(io.destination.get('C:/target/Notes/Zerotier.md')).toBe('Uses [[ideas::EEG]].');
    expect(io.source.get('Notes/Index.md')).toBe('See [[mathematics::Zerotier]].');
    expect(io.source.has('Projects/Zerotier.md')).toBe(false);
  });

  it('copies only the transformed destination', async () => {
    const io = readyIo();

    await executeMigrationPlan(plan('copy'), io);

    expect(io.source.get('Projects/Zerotier.md')).toBe('Uses [[EEG]].');
    expect(io.source.get('Notes/Index.md')).toBe('See [[Zerotier]].');
    expect(io.log).not.toContain('trash-source:Projects/Zerotier.md');
    expect(io.log.some((entry) => entry.startsWith('write-backlink:'))).toBe(false);
  });

  it('relinks backlinks without writing a destination or trashing source', async () => {
    const io = readyIo();

    await executeMigrationPlan(plan('relink'), io);

    expect(io.destination.size).toBe(0);
    expect(io.source.get('Projects/Zerotier.md')).toBe('Uses [[EEG]].');
    expect(io.source.get('Notes/Index.md')).toBe('See [[mathematics::Zerotier]].');
    expect(io.log).not.toContain('check-destination');
  });

  it('never overwrites an existing destination', async () => {
    const io = readyIo();
    io.destination.set('C:/target/Notes/Zerotier.md', 'existing');

    await expect(executeMigrationPlan(plan('move'), io)).rejects.toBeInstanceOf(DestinationExistsError);

    expect(io.destination.get('C:/target/Notes/Zerotier.md')).toBe('existing');
    expect(io.source.get('Notes/Index.md')).toBe('See [[Zerotier]].');
  });
});

describe('executeMigrationPlan rollback and stale protection', () => {
  it('rejects a stale plan before any write', async () => {
    const io = readyIo();
    io.source.set('Notes/Index.md', 'Changed after review.');

    await expect(executeMigrationPlan(plan('move'), io)).rejects
      .toBeInstanceOf(StaleMigrationPlanError);

    expect(io.destination.size).toBe(0);
    expect(io.log.some((entry) => entry.startsWith('write-'))).toBe(false);
  });

  it('does not remove an unowned destination when exclusive destination writing fails', async () => {
    const io = readyIo();
    io.failDestinationWrite = true;

    await expect(executeMigrationPlan(plan('move'), io)).rejects
      .toBeInstanceOf(MigrationExecutionError);

    expect(io.destination.get('C:/target/Notes/Zerotier.md')).toBe('concurrent destination');
    expect(io.source.get('Notes/Index.md')).toBe('See [[Zerotier]].');
    expect(io.source.has('Projects/Zerotier.md')).toBe(true);
  });

  it('does not claim a failed create publication when concurrent content equals the plan', async () => {
    const io = readyIo();
    io.failDestinationWrite = true;
    io.failDestinationAfterPublishingPlannedContent = true;

    await expect(executeMigrationPlan(plan('move'), io)).rejects
      .toBeInstanceOf(MigrationExecutionError);

    expect(io.destination.get('C:/target/Notes/Zerotier.md')).toBe('Uses [[ideas::EEG]].');
    expect(io.log).not.toContain('restore-destination');
  });

  it('does not claim a failed overwrite publication when stale content equals the plan', async () => {
    const io = readyIo();
    io.failDestinationWrite = true;
    io.failDestinationAfterPublishingPlannedContent = true;
    const overwritePlan = plan('move');
    overwritePlan.destinationPolicy = 'overwrite-reviewed';
    overwritePlan.destinationOriginalContent = 'existing';
    io.destination.set(overwritePlan.destinationAbsolutePath!, 'existing');

    await expect(executeMigrationPlan(overwritePlan, io)).rejects
      .toBeInstanceOf(MigrationExecutionError);

    expect(io.destination.get(overwritePlan.destinationAbsolutePath!)).toBe('Uses [[ideas::EEG]].');
    expect(io.log).not.toContain('restore-destination');
  });

  it('restores all attempted backlink edits and removes destination when a later edit fails', async () => {
    const io = readyIo();
    io.source.set('Notes/Second.md', 'Another [[Zerotier]].');
    io.failSourceWriteAt = 2;
    const twoBacklinks = plan('move');
    twoBacklinks.backlinkEdits.push({
      path: 'Notes/Second.md',
      originalContent: 'Another [[Zerotier]].',
      updatedContent: 'Another [[mathematics::Zerotier]].',
      rewrittenLinks: 1,
    });

    await expect(executeMigrationPlan(twoBacklinks, io)).rejects
      .toBeInstanceOf(MigrationExecutionError);

    expect(io.destination.size).toBe(0);
    expect(io.source.get('Notes/Index.md')).toBe('See [[Zerotier]].');
    expect(io.source.get('Notes/Second.md')).toBe('Another [[Zerotier]].');
    expect(io.source.has('Projects/Zerotier.md')).toBe(true);
  });

  it('rolls back destination and backlinks when trashing source fails', async () => {
    const io = readyIo();
    io.failTrash = true;

    await expect(executeMigrationPlan(plan('move'), io)).rejects
      .toBeInstanceOf(MigrationExecutionError);

    expect(io.destination.size).toBe(0);
    expect(io.source.get('Notes/Index.md')).toBe('See [[Zerotier]].');
    expect(io.source.has('Projects/Zerotier.md')).toBe(true);
  });

  it('restores the source if trash reports failure after removing it', async () => {
    const io = readyIo();
    io.failTrashAfterDelete = true;

    await expect(executeMigrationPlan(plan('move'), io)).rejects
      .toBeInstanceOf(MigrationExecutionError);

    expect(io.source.get('Projects/Zerotier.md')).toBe('Uses [[EEG]].');
    expect(io.source.get('Notes/Index.md')).toBe('See [[Zerotier]].');
    expect(io.destination.size).toBe(0);
  });

  it('reports rollback failures alongside the original error', async () => {
    const io = readyIo();
    io.failTrash = true;
    io.failRollbackPath = 'Notes/Index.md';

    const error = await executeMigrationPlan(plan('move'), io).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(MigrationExecutionError);
    expect((error as MigrationExecutionError).cause).toMatchObject({ message: 'trash failed' });
    expect((error as MigrationExecutionError).rollbackErrors.map((item) => item.message))
      .toContain('rollback failed: Notes/Index.md');
  });

  it('never creates backup or temporary sibling paths', async () => {
    const io = readyIo();
    io.failTrash = true;
    await expect(executeMigrationPlan(plan('move'), io)).rejects.toBeDefined();
    expect([...io.source.keys(), ...io.destination.keys()].some((file) =>
      /\.(?:bak|backup|tmp)$/i.test(file))).toBe(false);
  });
});

describe('executeMigrationPlan destination overwrite policy', () => {
  it('refuses to overwrite an existing destination under create-only policy', async () => {
    const io = readyIo();
    io.destination.set('C:/target/Notes/Zerotier.md', 'existing');

    await expect(executeMigrationPlan(plan('move'), io)).rejects.toBeInstanceOf(DestinationExistsError);

    expect(io.destination.get('C:/target/Notes/Zerotier.md')).toBe('existing');
  });

  it('overwrites a reviewed destination that still matches the reviewed content', async () => {
    const io = readyIo();
    const overwritePlan = plan('move');
    overwritePlan.destinationPolicy = 'overwrite-reviewed';
    overwritePlan.destinationOriginalContent = 'existing';
    io.destination.set(overwritePlan.destinationAbsolutePath!, 'existing');

    await executeMigrationPlan(overwritePlan, io);

    expect(io.destination.get(overwritePlan.destinationAbsolutePath!))
      .toBe('Uses [[ideas::EEG]].');
  });

  it('rejects a reviewed overwrite when the destination changed after review', async () => {
    const io = readyIo();
    const overwritePlan = plan('move');
    overwritePlan.destinationPolicy = 'overwrite-reviewed';
    overwritePlan.destinationOriginalContent = 'existing';
    io.destination.set(overwritePlan.destinationAbsolutePath!, 'changed after review');

    await expect(executeMigrationPlan(overwritePlan, io)).rejects.toBeInstanceOf(StaleMigrationPlanError);

    expect(io.destination.get(overwritePlan.destinationAbsolutePath!)).toBe('changed after review');
    expect(io.log.some((entry) => entry.startsWith('write-'))).toBe(false);
  });

  it('restores the original destination content when an overwrite rolls back', async () => {
    const io = readyIo();
    io.failTrash = true;
    const overwritePlan = plan('move');
    overwritePlan.destinationPolicy = 'overwrite-reviewed';
    overwritePlan.destinationOriginalContent = 'existing';
    io.destination.set(overwritePlan.destinationAbsolutePath!, 'existing');

    await expect(executeMigrationPlan(overwritePlan, io)).rejects.toBeInstanceOf(MigrationExecutionError);

    expect(io.destination.get(overwritePlan.destinationAbsolutePath!)).toBe('existing');
    expect(io.source.get('Notes/Index.md')).toBe('See [[Zerotier]].');
    expect(io.source.has('Projects/Zerotier.md')).toBe(true);
  });

  it('reports a destination ownership error and preserves concurrent content when rollback finds it tampered with', async () => {
    const io = readyIo();
    io.failSourceWriteAt = 1;
    io.concurrentDestinationWrite = 'tampered by another process';

    const error = await executeMigrationPlan(plan('move'), io).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(MigrationExecutionError);
    expect((error as MigrationExecutionError).rollbackErrors.some((item) =>
      item instanceof DestinationOwnershipError)).toBe(true);
    expect(io.destination.get('C:/target/Notes/Zerotier.md')).toBe('tampered by another process');
  });
});
