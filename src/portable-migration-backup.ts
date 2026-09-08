export interface BackupAdapter {
  exists(path: string): Promise<boolean>;
  read(path: string): Promise<string>;
  write(path: string, data: string): Promise<void>;
}

const FILES = [
  ['data.json', 'data.pre-portable-paths.json'],
  ['index-cache.json', 'index-cache.pre-portable-paths.json'],
] as const;

export async function backupPortableMigrationFiles(adapter: BackupAdapter, pluginDir: string): Promise<void> {
  for (const [sourceName, backupName] of FILES) {
    const source = `${pluginDir}/${sourceName}`;
    const backup = `${pluginDir}/${backupName}`;
    if (!await adapter.exists(source) || await adapter.exists(backup)) continue;
    const original = await adapter.read(source);
    await adapter.write(backup, original);
  }
}
