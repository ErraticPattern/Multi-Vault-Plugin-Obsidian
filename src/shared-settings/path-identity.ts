import { realpathSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import path from 'node:path';

const WINDOWS_PATH_PREFIX = /^[a-zA-Z]:[\\/]/;
const WINDOWS_UNC_PREFIX = /^(?:\\\\|\/\/)/;

function isWindowsPlatform(platform: NodeJS.Platform): boolean {
  return platform === 'win32';
}

function pathApiFor(platform: NodeJS.Platform): typeof path.win32 | typeof path.posix {
  return isWindowsPlatform(platform) ? path.win32 : path.posix;
}

function standardizeInputSeparators(input: string, platform: NodeJS.Platform): string {
  return isWindowsPlatform(platform)
    ? input.replace(/\//g, '\\')
    : input.replace(/\\/g, '/');
}

function toForwardSlashes(input: string): string {
  return input.replace(/\\/g, '/');
}

function normalizeResolvedPath(input: string, platform: NodeJS.Platform, lowercaseWindows: boolean): string {
  const pathApi = pathApiFor(platform);
  const resolved = pathApi.resolve(standardizeInputSeparators(input, platform));
  const root = toForwardSlashes(pathApi.parse(resolved).root);
  let normalized = toForwardSlashes(resolved);

  if (normalized.length > root.length && normalized.endsWith('/')) {
    normalized = normalized.replace(/\/+$/g, '');
  }

  if (lowercaseWindows && isWindowsPlatform(platform)) {
    normalized = normalized.toLowerCase();
  }

  return normalized;
}

function isEnoentError(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && (error as NodeJS.ErrnoException).code === 'ENOENT';
}

export function normalizePathDisplay(input: string, platform: NodeJS.Platform): string {
  return normalizeResolvedPath(input, platform, false);
}

export function normalizePathKey(input: string, platform: NodeJS.Platform): string {
  return normalizeResolvedPath(input, platform, true);
}

export function normalizeExistingPathKey(input: string, platform: NodeJS.Platform): string {
  try {
    return normalizePathKey(realpathSync(input), platform);
  } catch (error) {
    if (isEnoentError(error)) {
      return normalizePathKey(input, platform);
    }

    throw error;
  }
}

export async function normalizeVaultPath(input: string, platform: NodeJS.Platform): Promise<string> {
  try {
    return normalizePathKey(await realpath(input), platform);
  } catch (error) {
    if (isEnoentError(error)) {
      return normalizePathKey(input, platform);
    }

    throw error;
  }
}

export function inferPlatformFromPath(input: string, fallback: NodeJS.Platform = process.platform): NodeJS.Platform {
  if (WINDOWS_PATH_PREFIX.test(input) || WINDOWS_UNC_PREFIX.test(input)) {
    return 'win32';
  }

  return fallback;
}
