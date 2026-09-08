type Dialog = {
  showOpenDialog(options: { properties: ['openDirectory'] }): Promise<{ canceled: boolean; filePaths: string[] }>;
};
type ElectronModule = { dialog?: Dialog; remote?: { dialog?: Dialog } };

export async function pickVaultFolder(requireFn?: NodeRequire): Promise<string | null> {
  const runtimeRequire = requireFn ?? (globalThis as typeof globalThis & { require?: NodeRequire }).require;
  if (!runtimeRequire) throw new Error('Folder selection is available only in Obsidian Desktop.');
  const electron = runtimeRequire('electron') as ElectronModule;
  const dialog = electron.dialog ?? electron.remote?.dialog;
  if (!dialog) throw new Error('Obsidian Desktop did not expose a directory chooser.');
  const result = await dialog.showOpenDialog({ properties: ['openDirectory'] });
  return result.canceled ? null : result.filePaths[0] ?? null;
}
