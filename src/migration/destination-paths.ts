import * as fs from 'fs';
import * as path from 'path';

export interface IndexedNotePath {
  relativePath: string;
  basename: string;
}

export class UnsafeDestinationPathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsafeDestinationPathError';
  }
}

function toPosix(value: string): string {
  return value.replace(/\\/g, '/');
}

export function listDestinationFolders(vaultRoot: string): string[] {
  const folders = ['/'];

  const visit = (absoluteDirectory: string, relativeDirectory: string): void => {
    const entries = fs.readdirSync(absoluteDirectory, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name));

    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      const relativePath = relativeDirectory
        ? `${relativeDirectory}/${entry.name}`
        : entry.name;
      folders.push(relativePath);
      visit(path.join(absoluteDirectory, entry.name), relativePath);
    }
  };

  visit(path.resolve(vaultRoot), '');
  return folders;
}

function assertSimpleFileName(fileName: string): void {
  if (
    !fileName ||
    path.isAbsolute(fileName) ||
    fileName !== path.basename(fileName) ||
    fileName.includes('/') ||
    fileName.includes('\\')
  ) {
    throw new UnsafeDestinationPathError(`Unsafe destination filename: ${fileName}`);
  }
}

export function resolveDestinationPath(
  vaultRoot: string,
  folder: string,
  fileName: string,
): { absolutePath: string; relativePath: string } {
  assertSimpleFileName(fileName);
  if (folder !== '/' && (path.posix.isAbsolute(folder) || path.win32.isAbsolute(folder))) {
    throw new UnsafeDestinationPathError(`Unsafe destination folder: ${folder}`);
  }

  const root = path.resolve(vaultRoot);
  const normalizedFolder = folder === '/' ? '' : folder.replace(/[\\/]+/g, path.sep);
  const absoluteFolder = path.resolve(root, normalizedFolder);
  if (absoluteFolder !== root && !absoluteFolder.startsWith(`${root}${path.sep}`)) {
    throw new UnsafeDestinationPathError(`Destination escapes vault: ${folder}`);
  }

  const absolutePath = path.resolve(absoluteFolder, fileName);
  if (!absolutePath.startsWith(`${root}${path.sep}`)) {
    throw new UnsafeDestinationPathError(`Destination escapes vault: ${folder}/${fileName}`);
  }

  return {
    absolutePath,
    relativePath: toPosix(path.relative(root, absolutePath)),
  };
}

export function extensionlessMarkdownPath(relativePath: string): string {
  return relativePath.replace(/\.md$/i, '');
}

export function chooseCrossVaultNotePath(
  destinationRelativePath: string,
  indexedFiles: IndexedNotePath[],
): string {
  const normalizedDestination = toPosix(destinationRelativePath);
  const destinationWithoutExtension = extensionlessMarkdownPath(normalizedDestination);
  const basename = path.posix.basename(destinationWithoutExtension);
  const destinationLower = normalizedDestination.toLowerCase();
  const conflictingFiles = indexedFiles.filter((file) =>
    file.basename.toLowerCase() === basename.toLowerCase() &&
    toPosix(file.relativePath).toLowerCase() !== destinationLower,
  );
  if (conflictingFiles.length === 0) return basename;
  return destinationWithoutExtension.includes('/')
    ? destinationWithoutExtension
    : `/${destinationWithoutExtension}`;
}
