import * as path from 'path';

export type PathEnvironment = Record<string, string | undefined>;

export function getObsidianConfigCandidates(platform: string, env: PathEnvironment, home: string): string[] {
  let candidates: string[];
  if (platform === 'win32') {
    candidates = env.APPDATA ? [path.win32.join(env.APPDATA, 'Obsidian', 'obsidian.json')] : [];
  } else if (platform === 'darwin') {
    candidates = [path.posix.join(home, 'Library', 'Application Support', 'obsidian', 'obsidian.json')];
  } else if (platform === 'linux') {
    candidates = [
      path.posix.join(env.XDG_CONFIG_HOME || path.posix.join(home, '.config'), 'obsidian', 'obsidian.json'),
      path.posix.join(home, '.config', 'obsidian', 'obsidian.json'),
      path.posix.join(home, '.var', 'app', 'md.obsidian.Obsidian', 'config', 'obsidian', 'obsidian.json'),
      path.posix.join(home, 'snap', 'obsidian', 'current', '.config', 'obsidian', 'obsidian.json'),
    ];
  } else candidates = [];
  return [...new Set(candidates)];
}

export function expandPortablePath(value: string, env: PathEnvironment, home: string): string {
  let expanded = value.replace(/\\/g, '/');
  expanded = expanded.replace(/^~(?=\/|$)/, home)
    .replace(/^\$HOME(?=\/|$)/, home)
    .replace(/^\$\{HOME\}(?=\/|$)/, home);
  if (env.USERPROFILE) expanded = expanded.replace(/^%USERPROFILE%(?=\/|$)/i, env.USERPROFILE.replace(/\\/g, '/'));
  return path.normalize(expanded);
}

export function normalizeVaultPath(value: string, platform: string): string {
  const flavor = platform === 'win32' ? path.win32 : path.posix;
  const normalized = flavor.resolve(value.replace(/[\\/]+/g, flavor.sep));
  return platform === 'win32' ? normalized.toLowerCase() : normalized;
}

export function rebaseRelativePath(root: string, relativePath: string): string | null {
  if (path.posix.isAbsolute(relativePath) || path.win32.isAbsolute(relativePath)) return null;
  const normalized = relativePath.replace(/[\\/]+/g, path.sep);
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, normalized);
  return resolved.startsWith(`${resolvedRoot}${path.sep}`) ? resolved : null;
}
