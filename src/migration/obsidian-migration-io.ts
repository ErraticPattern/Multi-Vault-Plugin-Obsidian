import { TFile, type App } from 'obsidian';
import {
  link,
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  writeFile,
  type FileHandle,
} from 'fs/promises';
import * as path from 'path';
import { randomBytes } from 'crypto';
import {
  DestinationOwnershipError,
  StaleMigrationPlanError,
  type DestinationOwnershipToken,
  type MigrationIo,
} from './migration-transaction';

interface FileIdentity {
  dev: bigint;
  ino: bigint;
  birthtimeNs: bigint;
}

interface OwnedDestinationToken extends DestinationOwnershipToken {
  destination: string;
  identity: FileIdentity;
  writtenContent: string;
  originalContent: string | null;
}

export interface DestinationRaceHooks {
  beforeOverwritePublication?: () => Promise<void>;
  beforeCreateRemoval?: () => Promise<void>;
  beforeOverwriteRestore?: () => Promise<void>;
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === code;
}

function identityOf(stats: { dev: bigint; ino: bigint; birthtimeNs: bigint }): FileIdentity {
  return Object.freeze({ dev: stats.dev, ino: stats.ino, birthtimeNs: stats.birthtimeNs });
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.birthtimeNs === right.birthtimeNs;
}

async function readHandle(handle: FileHandle): Promise<Buffer> {
  const before = await handle.stat({ bigint: true });
  if (before.size > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error('Destination is too large to validate safely');
  }
  const buffer = Buffer.alloc(Number(before.size));
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
    if (bytesRead === 0) break;
    offset += bytesRead;
  }
  const after = await handle.stat({ bigint: true });
  if (after.size !== before.size || offset !== buffer.length) {
    throw new Error('Destination changed while its ownership was being validated');
  }
  return buffer;
}

async function handleContentEquals(handle: FileHandle, expected: string): Promise<boolean> {
  return (await readHandle(handle)).equals(Buffer.from(expected, 'utf8'));
}

async function writeHandle(handle: FileHandle, content: string): Promise<void> {
  const buffer = Buffer.from(content, 'utf8');
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesWritten } = await handle.write(buffer, offset, buffer.length - offset, offset);
    if (bytesWritten === 0) throw new Error('Could not restore destination content');
    offset += bytesWritten;
  }
  await handle.truncate(buffer.length);
  await handle.sync();
}

export class ObsidianMigrationIo implements MigrationIo {
  private readonly ownershipTokens = new WeakSet<object>();

  constructor(
    private readonly app: App,
    private readonly raceHooks: DestinationRaceHooks = {},
  ) {}

  async destinationExists(absolutePath: string): Promise<boolean> {
    try {
      await lstat(absolutePath);
      return true;
    } catch (error: unknown) {
      if (isNodeError(error, 'ENOENT')) return false;
      throw error;
    }
  }

  async readDestination(absolutePath: string): Promise<string> {
    return readFile(absolutePath, 'utf8');
  }

  async writeDestination(
    absolutePath: string,
    content: string,
    expectedOriginal: string | null,
  ): Promise<DestinationOwnershipToken> {
    await mkdir(path.dirname(absolutePath), { recursive: true });
    const stagePath = `${absolutePath}.mvp-stage-${randomBytes(8).toString('hex')}`;
    try {
      await writeFile(stagePath, content, { encoding: 'utf8', flag: 'wx' });
      if (expectedOriginal === null) {
        return await this.publishCreate(absolutePath, stagePath, content);
      }
      return await this.publishOverwrite(absolutePath, stagePath, content, expectedOriginal);
    } finally {
      await rm(stagePath).catch((error: unknown) => {
        if (!isNodeError(error, 'ENOENT')) throw error;
      });
    }
  }

  async restoreDestination(
    absolutePath: string,
    ownership: DestinationOwnershipToken,
  ): Promise<void> {
    const token = this.requireOwnership(absolutePath, ownership);
    if (token.originalContent === null) {
      await this.removeOwnedCreate(token);
      return;
    }
    await this.restoreOwnedOverwrite(token);
  }

  async readSourceFile(vaultPath: string): Promise<string> {
    const file = this.getSourceMarkdownFile(vaultPath);
    return this.app.vault.read(file);
  }

  async writeSourceFile(vaultPath: string, content: string): Promise<void> {
    const file = this.getSourceMarkdownFile(vaultPath);
    await this.app.vault.modify(file, content);
  }

  async trashSourceFile(vaultPath: string): Promise<void> {
    const file = this.getSourceMarkdownFile(vaultPath);
    await this.app.fileManager.trashFile(file);
  }

  async restoreSourceFile(vaultPath: string, content: string): Promise<void> {
    const existing = this.app.vault.getAbstractFileByPath(vaultPath);
    if (existing instanceof TFile) {
      await this.app.vault.modify(existing, content);
      return;
    }
    await this.app.vault.create(vaultPath, content);
  }

  private async publishCreate(
    absolutePath: string,
    stagePath: string,
    content: string,
  ): Promise<DestinationOwnershipToken> {
    // A same-directory hard link gives create-only publication atomic EEXIST semantics
    // without exposing a partially written destination.
    await link(stagePath, absolutePath);
    const [published, staged] = await Promise.all([
      lstat(absolutePath, { bigint: true }),
      lstat(stagePath, { bigint: true }),
    ]);
    const identity = identityOf(published);
    if (!sameIdentity(identity, identityOf(staged))) {
      throw new StaleMigrationPlanError(absolutePath);
    }
    return this.createOwnership(absolutePath, identity, content, null);
  }

  private async publishOverwrite(
    absolutePath: string,
    stagePath: string,
    content: string,
    expectedOriginal: string,
  ): Promise<DestinationOwnershipToken> {
    await this.assertReviewedDestination(absolutePath, expectedOriginal);
    await this.raceHooks.beforeOverwritePublication?.();
    await this.assertReviewedDestination(absolutePath, expectedOriginal);

    // Node exposes no portable rename compare-and-swap. A non-cooperating process can
    // still replace this directory entry after the final identity check and before
    // rename. The checks here narrow that irreducible window without claiming CAS.
    await rename(stagePath, absolutePath);

    const handle = await open(absolutePath, 'r');
    try {
      const identity = identityOf(await handle.stat({ bigint: true }));
      const pathIdentity = await this.readPathIdentity(absolutePath);
      const contentMatches = await handleContentEquals(handle, content);
      if (!sameIdentity(identity, pathIdentity) || !contentMatches) {
        throw new StaleMigrationPlanError(absolutePath);
      }
      return this.createOwnership(absolutePath, identity, content, expectedOriginal);
    } finally {
      await handle.close();
    }
  }

  private async assertReviewedDestination(absolutePath: string, expected: string): Promise<void> {
    let handle: FileHandle;
    try {
      handle = await open(absolutePath, 'r');
    } catch (error: unknown) {
      if (isNodeError(error, 'ENOENT')) throw new StaleMigrationPlanError(absolutePath);
      throw error;
    }
    try {
      const handleIdentity = identityOf(await handle.stat({ bigint: true }));
      const pathIdentity = await this.readPathIdentity(absolutePath, true);
      if (!sameIdentity(handleIdentity, pathIdentity) || !await handleContentEquals(handle, expected)) {
        throw new StaleMigrationPlanError(absolutePath);
      }
    } finally {
      await handle.close();
    }
  }

  private createOwnership(
    destination: string,
    identity: FileIdentity,
    writtenContent: string,
    originalContent: string | null,
  ): DestinationOwnershipToken {
    const token = Object.freeze({
      destination,
      identity,
      writtenContent,
      originalContent,
    }) as OwnedDestinationToken;
    this.ownershipTokens.add(token);
    return token;
  }

  private requireOwnership(
    absolutePath: string,
    ownership: DestinationOwnershipToken,
  ): OwnedDestinationToken {
    if (!this.ownershipTokens.has(ownership) ||
        (ownership as OwnedDestinationToken).destination !== absolutePath) {
      throw new DestinationOwnershipError(absolutePath);
    }
    return ownership as OwnedDestinationToken;
  }

  private async removeOwnedCreate(token: OwnedDestinationToken): Promise<void> {
    await this.assertCurrentOwnership(token);
    await this.raceHooks.beforeCreateRemoval?.();
    await this.assertCurrentOwnership(token);

    // Node has no portable unlink-by-handle or identity-conditional unlink. This final
    // lstat is deliberately adjacent to rm. A non-cooperating replacement in between
    // remains an irreducible race in Node, so this is not a filesystem CAS guarantee.
    const finalIdentity = await this.readPathIdentity(token.destination);
    if (!sameIdentity(finalIdentity, token.identity)) {
      throw new DestinationOwnershipError(token.destination);
    }
    try {
      await rm(token.destination);
    } catch (error: unknown) {
      if (isNodeError(error, 'ENOENT')) throw new DestinationOwnershipError(token.destination);
      throw error;
    }
  }

  private async restoreOwnedOverwrite(token: OwnedDestinationToken): Promise<void> {
    let actionHandle: FileHandle;
    try {
      actionHandle = await open(token.destination, 'r+');
    } catch (error: unknown) {
      if (isNodeError(error, 'ENOENT')) throw new DestinationOwnershipError(token.destination);
      throw error;
    }
    try {
      await this.assertHandleOwnership(actionHandle, token);
      await this.raceHooks.beforeOverwriteRestore?.();
      await this.assertCurrentOwnership(token);
      await this.assertHandleOwnership(actionHandle, token);

      // Mutation uses the already verified descriptor. If the path is atomically
      // replaced after validation, writes continue to the owned inode and cannot be
      // redirected to the replacement. The post-write path check then reports loss
      // of ownership rather than claiming rollback success. Node also has no portable
      // content compare-and-swap, so a non-cooperating in-place write in the narrow
      // interval after validation remains irreducible.
      await writeHandle(actionHandle, token.originalContent!);
      const currentPathIdentity = await this.readPathIdentity(token.destination);
      if (!sameIdentity(currentPathIdentity, token.identity)) {
        throw new DestinationOwnershipError(token.destination);
      }
    } finally {
      await actionHandle.close();
    }
  }

  private async assertCurrentOwnership(token: OwnedDestinationToken): Promise<void> {
    let handle: FileHandle;
    try {
      handle = await open(token.destination, 'r');
    } catch (error: unknown) {
      if (isNodeError(error, 'ENOENT')) throw new DestinationOwnershipError(token.destination);
      throw error;
    }
    try {
      await this.assertHandleOwnership(handle, token);
      const pathIdentity = await this.readPathIdentity(token.destination);
      if (!sameIdentity(pathIdentity, token.identity)) {
        throw new DestinationOwnershipError(token.destination);
      }
    } finally {
      await handle.close();
    }
  }

  private async assertHandleOwnership(handle: FileHandle, token: OwnedDestinationToken): Promise<void> {
    const identity = identityOf(await handle.stat({ bigint: true }));
    if (!sameIdentity(identity, token.identity) || !await handleContentEquals(handle, token.writtenContent)) {
      throw new DestinationOwnershipError(token.destination);
    }
  }

  private async readPathIdentity(absolutePath: string, staleIfMissing = false): Promise<FileIdentity> {
    try {
      return identityOf(await lstat(absolutePath, { bigint: true }));
    } catch (error: unknown) {
      if (isNodeError(error, 'ENOENT')) {
        if (staleIfMissing) throw new StaleMigrationPlanError(absolutePath);
        throw new DestinationOwnershipError(absolutePath);
      }
      throw error;
    }
  }

  private getSourceMarkdownFile(vaultPath: string): TFile {
    const file = this.app.vault.getAbstractFileByPath(vaultPath);
    if (!(file instanceof TFile)) throw new Error(`Source file not found: ${vaultPath}`);
    if (file.extension.toLowerCase() !== 'md') {
      throw new Error(`Source file is not Markdown: ${vaultPath}`);
    }
    return file;
  }
}
