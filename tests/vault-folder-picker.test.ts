import { describe, expect, it } from 'vitest';
import { pickVaultFolder } from '../src/vault-folder-picker';

describe('vault folder picker', () => {
  it('returns a selected directory', async () => {
    const requireFn = () => ({ dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: ['/vault'] }) } });
    await expect(pickVaultFolder(requireFn as never)).resolves.toBe('/vault');
  });
  it('returns null on cancellation', async () => {
    const requireFn = () => ({ remote: { dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) } } });
    await expect(pickVaultFolder(requireFn as never)).resolves.toBeNull();
  });
  it('reports unavailable desktop APIs', async () => {
    await expect(pickVaultFolder(undefined)).rejects.toThrow(/Desktop/);
  });
});
