export const MOVE_COPY_COMMAND_ID = 'multi-vault-move-copy';
export const RELINK_BACKLINKS_COMMAND_ID = 'multi-vault-relink-backlinks';

export interface CommandHost {
  addCommand(command: { id: string; name: string; callback: () => void }): unknown;
}

export interface MigrationModalFactories {
  openMoveCopy(): void;
  openRelink(): void;
}

export function registerMigrationCommands(
  host: CommandHost,
  factories: MigrationModalFactories,
): void {
  host.addCommand({
    id: MOVE_COPY_COMMAND_ID,
    name: 'Move/Copy Current File to Vault',
    callback: factories.openMoveCopy,
  });
  host.addCommand({
    id: RELINK_BACKLINKS_COMMAND_ID,
    name: 'Relink Backlinks to Existing Cross-Vault Note',
    callback: factories.openRelink,
  });
}
