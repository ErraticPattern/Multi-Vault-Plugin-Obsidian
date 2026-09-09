import { access, cp } from 'node:fs/promises';
import path from 'node:path';

export interface BackupAdapter {
  exists(path: string): Promise<boolean>;
  read(path: string): Promise<string>;
  write(path: string, data: string): Promise<void>;
}

const FILES = [
  ['data.json', 'data.pre-portable-paths.json'],
  ['index-cache.json', 'index-cache.pre-portable-paths.json'],
] as const;

export async function backupSharedSettingsJournal(applicationDataRoot: string): Promise<void> {
  const source = path.join(applicationDataRoot, 'shared-settings-v1');
  const backup = `${source}.pre-portable-paths`;
  try { await access(source); } catch { return; }
  try { await access(backup); return; } catch { /* create the first backup */ }
  await cp(source, backup, { recursive: true, errorOnExist: true, force: false });
}

export async function backupPortableMigrationFiles(adapter: BackupAdapter, pluginDir: string): Promise<void> {
  for (const [sourceName, backupName] of FILES) {
    const source = `${pluginDir}/${sourceName}`;
    const backup = `${pluginDir}/${backupName}`;
    if (!await adapter.exists(source) || await adapter.exists(backup)) continue;
    const original = await adapter.read(source);
    await adapter.write(backup, original);
  }
}
