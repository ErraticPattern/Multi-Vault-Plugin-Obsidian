import { App, ButtonComponent, Notice, PluginSettingTab, Setting, SettingDefinitionItem, SettingGroupItem, requireApiVersion } from 'obsidian';
import { VaultRegistry } from './vault-registry';
import { Indexer } from './indexer/indexer';
import MultiVaultNavigatorPlugin from './main';
import { ExcludeSuggestModal } from './modals/exclude-suggest-modal';

// Loose shape for manually rendering 1.13-style setting definitions on 1.12.x.
type ManualRenderItem = {
  name?: string | DocumentFragment;
  desc?: string | DocumentFragment;
  render?: (setting: Setting, group?: unknown) => unknown;
};

// setDestructive() only exists on Obsidian 1.13+; fall back to setWarning().
function markButtonDestructive(button: ButtonComponent): ButtonComponent {
  const maybe = button as ButtonComponent & { setDestructive?: () => unknown };
  if (typeof maybe.setDestructive === 'function') {
    maybe.setDestructive();
  } else {
    button.setWarning();
  }
  return button;
}

export class MultiVaultSettingsTab extends PluginSettingTab {
  plugin: MultiVaultNavigatorPlugin;
  vaultRegistry: VaultRegistry;
  indexer: Indexer;
  private newVaultPath = "";
  private excludeTimeout: number | null = null;

  constructor(app: App, plugin: MultiVaultNavigatorPlugin, vaultRegistry: VaultRegistry, indexer: Indexer) {
    super(app, plugin);
    this.plugin = plugin;
    this.vaultRegistry = vaultRegistry;
    this.indexer = indexer;
  }

  // Obsidian 1.13+ renders getSettingDefinitions() natively and never calls
  // display(). 1.12.x has no declarative support and calls display() — render
  // the same schema manually there so one codebase serves both versions.
  display(): void {
    if (requireApiVersion('1.13.0')) return;
    this.renderDefinitionsManually();
  }

  update(): void {
    const nativeUpdate = (PluginSettingTab.prototype as unknown as { update?: () => void }).update;
    if (requireApiVersion('1.13.0') && typeof nativeUpdate === 'function') {
      nativeUpdate.call(this);
    } else {
      this.renderDefinitionsManually();
    }
  }

  private renderDefinitionsManually(): void {
    const { containerEl } = this;
    containerEl.empty();
    for (const definition of this.getSettingDefinitions()) {
      if ('type' in definition && (definition.type === 'group' || definition.type === 'list')) {
        if (definition.heading) {
          new Setting(containerEl).setName(definition.heading).setHeading();
        }
        for (const item of definition.items ?? []) {
          this.renderItemManually(containerEl, item as ManualRenderItem);
        }
      } else {
        this.renderItemManually(containerEl, definition as ManualRenderItem);
      }
    }
  }

  private renderItemManually(containerEl: HTMLElement, item: ManualRenderItem): void {
    const setting = new Setting(containerEl);
    if (item.name) setting.setName(item.name);
    if (item.desc) setting.setDesc(item.desc);
    try {
      item.render?.(setting);
    } catch (error) {
      console.error('Multi-Vault Navigator: failed to render setting', item.name, error);
    }
  }

  getSettingDefinitions(): SettingDefinitionItem[] {
    const vaults = this.vaultRegistry.getVaults();
    const configuredVaultItems: SettingGroupItem[] = vaults.length === 0 ? [
      {
        name: 'No vaults configured.'
      }
    ] : vaults.map(vault => {
      const isCurrent = this.vaultRegistry.getCurrentVaultId() === vault.id;
      const nameText = isCurrent ? `${vault.name} (Current)` : vault.name;

      return {
        name: nameText,
        desc: vault.path,
        render: (setting: Setting) => {
          if (typeof setting.addColorPicker === 'function') {
            setting.addColorPicker(color => color
              .setValue(vault.color || '#000000')
              .onChange(async (value) => {
                this.vaultRegistry.updateVault(vault.id, { color: value });
                await this.plugin.saveSettings();
              })
            );
          } else {
            setting.addText(text => text
              .setPlaceholder("#Hex")
              .setValue(vault.color || '#000000')
              .onChange(async (value) => {
                this.vaultRegistry.updateVault(vault.id, { color: value });
                await this.plugin.saveSettings();
              })
            );
          }
          setting
            .addText(text => text
              .setPlaceholder("Icon")
              .setValue(vault.icon || "")
              .onChange(async (value) => {
                this.vaultRegistry.updateVault(vault.id, { icon: value });
                await this.plugin.saveSettings();
              })
            )
            .addToggle(toggle => toggle
              .setValue(vault.enabled)
              .onChange(async (value) => {
                this.vaultRegistry.updateVault(vault.id, { enabled: value });
                await this.plugin.saveSettings();
              })
            )
            .addButton(button => {
              button.setButtonText("Remove");
              markButtonDestructive(button);
              return button.onClick(async () => {
                this.vaultRegistry.removeVault(vault.id);
                await this.plugin.saveSettings();
                this.update();
              });
            });
        }
      };
    });

    return [
      {
        type: 'group',
        heading: 'Auto-detect Vaults',
        items: [
          {
            name: 'Auto-detect Vaults',
            desc: 'Vaults are automatically detected from Obsidian global settings upon plugin start. You can also manually add them below.'
          }
        ]
      },
      {
        type: 'group',
        heading: 'Configured Vaults',
        items: configuredVaultItems
      },
      {
        type: 'group',
        heading: 'Add Manual Vault',
        items: [
          {
            name: "Vault Path",
            desc: "Absolute path to the vault folder",
            render: (setting: Setting) => {
              setting
                .addText(text => text
                  .setPlaceholder("C:/My/Vault")
                  .setValue(this.newVaultPath)
                  .onChange(value => {
                    this.newVaultPath = value;
                  })
                )
                .addButton(btn => btn
                  .setButtonText("Add")
                  .setCta()
                  .onClick(async () => {
                    if (this.newVaultPath) {
                      const name = this.newVaultPath.split(/[/\\]/).pop() || "Unnamed Vault";
                      const success = this.vaultRegistry.addVault({
                        id: `vault-${Date.now()}`,
                        name,
                        path: this.newVaultPath,
                        enabled: true
                      });
                      if (success) {
                        this.newVaultPath = "";
                        await this.plugin.saveSettings();
                        this.update();
                      }
                    }
                  })
                );
            }
          }
        ]
      },
      {
        type: 'group',
        heading: 'Indexing',
        items: [
          {
            name: "Clear Index",
            desc: "Wipe the cross-vault index cache entirely.",
            render: (setting: Setting) => {
              setting.addButton(btn => markButtonDestructive(btn)
                .setButtonText("Clear Cache")
                .onClick(async () => {
                  await this.indexer.clearIndex();
                  this.plugin.refreshSearchEngine();
                })
              );
            }
          },
          {
            name: "Refresh Index",
            desc: "Re-scan all enabled vaults and rebuild the cross-vault index.",
            render: (setting: Setting) => {
              setting.addButton(btn => btn
                .setButtonText("Refresh Now")
                .setCta()
                .onClick(async () => {
                  await this.indexer.buildFullIndex(true);
                  this.plugin.refreshSearchEngine();
                })
              );
            }
          },
          {
            name: "Max Preview Characters",
            desc: "Maximum length of content snippet to index per file.",
            render: (setting: Setting) => {
              setting.addText(text => text
                .setValue(this.plugin.settings.indexOptions.maxPreviewChars.toString())
                .onChange(async (value) => {
                  const parsed = parseInt(value, 10);
                  if (!isNaN(parsed) && parsed > 0) {
                    this.plugin.settings.indexOptions.maxPreviewChars = parsed;
                    await this.plugin.saveSettings();
                  }
                })
              );
            }
          },
          {
            name: "Store Snippets in Cache",
            desc: "Warning: If enabled, note previews from all vaults are saved to a local JSON file in your active vault. Disable this if you regularly push your active vault's config folder to public repos, as it may leak cross-vault contents.",
            render: (setting: Setting) => {
              setting.addToggle(toggle => toggle
                .setValue(this.plugin.settings.indexOptions.storeSnippetsInCache !== false)
                .onChange(async (value) => {
                  this.plugin.settings.indexOptions.storeSnippetsInCache = value;
                  await this.plugin.saveSettings();
                  await this.indexer.buildFullIndex(true);
                })
              );
            }
          },
          {
            name: "Global Exclude Patterns",
            desc: "Comma-separated list of folder or file names to ignore across all vaults (e.g. 'Private, diary.md').",
            render: (setting: Setting) => {
              setting
                .addTextArea(text => text
                  .setPlaceholder("Private, Secrets, hidden")
                  .setValue((this.plugin.settings.indexOptions.globalExcludePatterns || []).join(', '))
                  .onChange(async (value) => {
                    const patterns = value.split(',').map(s => s.trim()).filter(s => s.length > 0);
                    this.plugin.settings.indexOptions.globalExcludePatterns = patterns;
                    await this.plugin.saveSettings();

                    if (this.excludeTimeout !== null) {
                      window.clearTimeout(this.excludeTimeout);
                    }
                    this.excludeTimeout = window.setTimeout(() => {
                      void this.refreshIndexFromSettings();
                    }, 1500);
                  })
                )
                .addButton(btn => btn
                  .setButtonText("Select File/Folder")
                  .onClick(() => {
                    new ExcludeSuggestModal(this.app, this.indexer, (selectedItem) => {
                      void this.addExcludePattern(selectedItem);
                    }).open();
                  })
                );
            }
          }
        ]
      },
      {
        type: 'group',
        heading: 'Appearance',
        items: [
          {
            name: "Search Result Layout",
            desc: "Choose the visual style for the search results in the Command Center.",
            render: (setting: Setting) => {
              setting.addDropdown(dropdown => {
                dropdown.addOption('classic', 'Classic List');
                dropdown.addOption('modern', 'Modern Card');
                dropdown.setValue(this.plugin.settings.uiStyle || 'classic');
                dropdown.onChange(async (value) => {
                  this.plugin.settings.uiStyle = value as 'classic' | 'modern';
                  await this.plugin.saveSettings();
                });
              });
            }
          }
        ]
      }
    ];
  }

  private async addExcludePattern(selectedItem: string): Promise<void> {
    const patterns = this.plugin.settings.indexOptions.globalExcludePatterns || [];
    if (!patterns.includes(selectedItem)) {
      patterns.push(selectedItem);
      this.plugin.settings.indexOptions.globalExcludePatterns = patterns;
      await this.plugin.saveSettings();
      this.update();

      await this.indexer.buildFullIndex(true);
      this.plugin.refreshSearchEngine();
    }
  }

  private async refreshIndexFromSettings(): Promise<void> {
    try {
      await this.indexer.buildFullIndex(true);
      this.plugin.refreshSearchEngine();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      new Notice(`Failed to refresh index: ${message}`);
    }
  }
}
