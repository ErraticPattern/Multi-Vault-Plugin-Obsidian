import { App, ButtonComponent, Notice, PluginSettingTab, Setting, SettingDefinitionItem, SettingGroupItem, requireApiVersion } from 'obsidian';
import { VaultRegistry } from './vault-registry';
import { Indexer } from './indexer/indexer';
import type MultiVaultNavigatorPlugin from './main';
import { ExcludeSuggestModal } from './modals/exclude-suggest-modal';
import { VirtualLinkTargetsModal } from './modals/virtual-link-targets-modal';
import type { SharedSettingsPatch } from './shared-settings/shared-settings-store';
import type { VirtualLinkColorMode } from './shared-settings/shared-settings-types';
import { normalizeExistingPathKey, normalizePathDisplay } from './shared-settings/path-identity';

const VIRTUAL_LINKER_PLUGIN_ID = 'virtual-linker';
const VIRTUAL_LINKER_REPOSITORY_URL = 'https://github.com/ErraticPattern/obsidian-virtual-linker';

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
  private declarativeRefresh: Promise<void> | null = null;
  private suppressDeclarativeRefresh = false;

  constructor(app: App, plugin: MultiVaultNavigatorPlugin, vaultRegistry: VaultRegistry, indexer: Indexer) {
    super(app, plugin);
    this.plugin = plugin;
    this.vaultRegistry = vaultRegistry;
    this.indexer = indexer;
  }

  // Obsidian 1.13+ renders getSettingDefinitions() natively and cannot await a
  // refresh there, so the first definition request schedules one background
  // apply and updates once if that changes visible state. 1.12.x still calls
  // display() directly, so keep the manual async render path there.
  display(): void {
    if (this.usesDeclarativeSettings()) return;
    void this.applyLatestAndRender(false);
  }

  update(): void {
    if (this.usesDeclarativeSettings()) {
      this.runNativeUpdate();
      return;
    }
    void this.applyLatestAndRender(true);
  }

  private usesDeclarativeSettings(): boolean {
    return requireApiVersion('1.13.0');
  }

  private runNativeUpdate(): void {
    const nativeUpdate = (PluginSettingTab.prototype as unknown as { update?: () => void }).update;
    if (typeof nativeUpdate === 'function') nativeUpdate.call(this);
  }

  private scheduleDeclarativeRefresh(): void {
    if (!this.usesDeclarativeSettings() || this.suppressDeclarativeRefresh || this.declarativeRefresh !== null) {
      return;
    }

    const service = this.plugin.sharedSettingsService;
    if (!service) return;

    this.declarativeRefresh = (async () => {
      try {
        const result = await service.applyLatest(true);
        if (result.kind === 'error') {
          new Notice(`Shared configuration could not be refreshed: ${result.message}`);
          return;
        }
        if (result.kind === 'unchanged') return;

        this.suppressDeclarativeRefresh = true;
        try {
          this.update();
        } finally {
          void Promise.resolve().then(() => {
            this.suppressDeclarativeRefresh = false;
          });
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        new Notice(`Shared configuration could not be refreshed: ${message}`);
      }
    })().finally(() => {
      this.declarativeRefresh = null;
    });
  }

  private async applyLatestAndRender(useNativeUpdate: boolean): Promise<void> {
    const service = this.plugin.sharedSettingsService;
    if (service) {
      const result = await service.applyLatest(true);
      if (result.kind === 'error') {
        new Notice(`Shared configuration could not be refreshed: ${result.message}`);
      }
    }

    if (this.usesDeclarativeSettings()) {
      if (useNativeUpdate) this.runNativeUpdate();
      return;
    }
    this.renderDefinitionsManually();
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
    this.scheduleDeclarativeRefresh();
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
          const changeColor = async (value: string): Promise<void> => {
            await this.changeSharedSetting(
              { kind: 'set-vault-color', vaultId: vault.id, color: value },
              () => this.vaultRegistry.updateVault(vault.id, { color: value }),
            );
          };
          if (typeof setting.addColorPicker === 'function') {
            setting.addColorPicker(color => color
              .setValue(vault.color || '#000000')
              .onChange(changeColor)
            );
          } else {
            setting.addText(text => text
              .setPlaceholder("#Hex")
              .setValue(vault.color || '#000000')
              .onChange(changeColor)
            );
          }
          setting
            .addText(text => text
              .setPlaceholder("Icon")
              .setValue(vault.icon || "")
              .onChange(async (value) => {
                await this.changeSharedSetting(
                  { kind: 'set-vault-icon', vaultId: vault.id, icon: value || undefined },
                  () => this.vaultRegistry.updateVault(vault.id, { icon: value || undefined }),
                );
              })
            )
            .addToggle(toggle => toggle
              .setValue(vault.enabled)
              .onChange(async (value) => {
                await this.changeSharedSetting(
                  { kind: 'set-vault-enabled', vaultId: vault.id, enabled: value },
                  () => this.vaultRegistry.updateVault(vault.id, { enabled: value }),
                );
              })
            )
            .addButton(button => {
              button.setButtonText("Remove");
              markButtonDestructive(button);
              return button.onClick(async () => {
                await this.changeSharedSetting(
                  { kind: 'remove-vault', vaultId: vault.id },
                  () => this.vaultRegistry.removeVault(vault.id),
                );
                this.update();
              });
            });
        }
      };
    });

    const sharedEnabled = this.plugin.isSharedConfigurationEnabled();
    const virtualLinks = this.plugin.settings.virtualLinks ?? {
      enabled: false,
      excludedSourceVaultIds: [],
      targetVaultIdsBySource: {},
      colorMode: 'soft-pill' as const,
      colorIntensity: 55,
    };
    const sharedConfigurationItems: SettingGroupItem[] = [
      {
        name: 'Enable shared configuration',
        desc: 'Synchronize canonical vault identity, appearance, participation, and Virtual Linker scope.',
        render: (setting: Setting) => {
          setting.addToggle((toggle) => toggle
            .setValue(sharedEnabled)
            .onChange(async (enabled) => {
              await this.plugin.setSharedConfigurationEnabled(enabled);
              this.update();
            }));
        },
      },
      {
        name: 'Sync now',
        desc: 'Force a check and reapply the latest shared revision.',
        render: (setting: Setting) => {
          setting.addButton((button) => button
            .setButtonText('Sync now')
            .setCta()
            .onClick(async () => {
              await this.plugin.syncSharedConfigurationNow();
              this.update();
            }));
        },
      },
      {
        name: 'Show status',
        desc: 'Show journal path, revisions, participation, last application, and errors.',
        render: (setting: Setting) => {
          setting.addButton((button) => button
            .setButtonText('Show status')
            .onClick(() => this.plugin.showSharedConfigurationStatus()));
        },
      },
      ...vaults.map((vault): SettingGroupItem => ({
        name: `Shared participation: ${vault.name}`,
        desc: vault.path,
        render: (setting: Setting) => {
          const isCurrent = this.vaultRegistry.getCurrentVaultId() === vault.id;
          const excluded = isCurrent && this.plugin.sharedSettingsService?.getStatus().excluded
            ? true
            : this.plugin.settings.excludedVaultIds?.includes(vault.id) === true;
          setting.addToggle((toggle) => toggle
            .setValue(!excluded)
            .onChange(async (participating) => {
              await this.changeSharedSetting(
                { kind: 'set-vault-excluded', vaultId: vault.id, excluded: !participating },
                () => {
                  const exclusions = new Set(this.plugin.settings.excludedVaultIds ?? []);
                  if (participating) exclusions.delete(vault.id);
                  else exclusions.add(vault.id);
                  this.plugin.settings.excludedVaultIds = [...exclusions];
                },
              );
            }));
        },
      })),
    ];

    const virtualLinkerInstalled = this.isVirtualLinkerInstalled();
    const virtualLinkerItems: SettingGroupItem[] = [
      {
        name: 'Virtual Linker plugin',
        // These settings only describe what a separate plugin should do. Without it
        // they are inert, so say so plainly instead of letting them look broken.
        desc: virtualLinkerInstalled
          ? 'Detected. The settings below control how the Virtual Linker links notes across vaults.'
          : 'Not detected. These settings are still stored and shared with your other vaults, but nothing happens until the Virtual Linker plugin is installed and enabled.',
        render: (setting: Setting) => {
          if (virtualLinkerInstalled) return;
          setting.addButton((button) => button
            .setButtonText('Get the plugin')
            .onClick(() => {
              window.open(VIRTUAL_LINKER_REPOSITORY_URL, '_blank');
            }));
        },
      },
      {
        name: 'Enable Virtual Linker integration',
        desc: 'Expose explicitly selected external vault targets through the optional integration.',
        render: (setting: Setting) => {
          setting.addToggle((toggle) => toggle
            .setValue(virtualLinks.enabled)
            .onChange(async (enabled) => {
              await this.changeSharedSetting(
                { kind: 'set-virtual-links-enabled', enabled },
                () => { this.ensureVirtualLinks().enabled = enabled; },
              );
            }));
        },
      },
      ...vaults.map((sourceVault): SettingGroupItem => ({
        name: `Virtual Linker targets from ${sourceVault.name}`,
        desc: 'Choose external target vaults for this source vault. No targets are selected by default.',
        render: (setting: Setting) => {
          const sourceExcluded = virtualLinks.excludedSourceVaultIds.includes(sourceVault.id);
          setting.addToggle((toggle) => toggle
            .setValue(!sourceExcluded)
            .onChange(async (participating) => {
              await this.changeSharedSetting(
                {
                  kind: 'set-virtual-link-source-excluded',
                  vaultId: sourceVault.id,
                  excluded: !participating,
                },
                () => {
                  const links = this.ensureVirtualLinks();
                  const exclusions = new Set(links.excludedSourceVaultIds);
                  if (participating) exclusions.delete(sourceVault.id);
                  else exclusions.add(sourceVault.id);
                  links.excludedSourceVaultIds = [...exclusions];
                },
              );
            }));
          setting.addButton((button) => button
            .setButtonText('Select targets')
            .onClick(() => {
              const selected = this.ensureVirtualLinks().targetVaultIdsBySource[sourceVault.id] ?? [];
              new VirtualLinkTargetsModal(
                this.app,
                sourceVault,
                vaults,
                selected,
                async (targetVaultIds) => {
                  await this.changeSharedSetting(
                    { kind: 'set-virtual-link-targets', sourceVaultId: sourceVault.id, targetVaultIds },
                    () => { this.ensureVirtualLinks().targetVaultIdsBySource[sourceVault.id] = [...targetVaultIds]; },
                  );
                },
              ).open();
            }));
        },
      })),
      {
        name: 'Virtual-link color mode',
        desc: 'Choose how target-vault provenance is styled.',
        render: (setting: Setting) => {
          setting.addDropdown((dropdown) => dropdown
            .addOption('off', 'Off')
            .addOption('muted-text', 'Muted text')
            .addOption('colored-underline', 'Colored underline')
            .addOption('soft-pill', 'Soft pill')
            .setValue(virtualLinks.colorMode)
            .onChange(async (mode) => {
              const colorMode = mode as VirtualLinkColorMode;
              await this.changeSharedSetting(
                { kind: 'set-virtual-link-style', mode: colorMode, intensity: this.virtualLinkIntensity() },
                () => { this.ensureVirtualLinks().colorMode = colorMode; },
              );
            }));
        },
      },
      {
        name: 'Virtual-link color intensity',
        desc: 'Set provenance color intensity from 10 to 90 percent.',
        render: (setting: Setting) => {
          setting.addSlider((slider) => slider
            .setLimits(10, 90, 1)
            .setValue(this.virtualLinkIntensity())
            .setDynamicTooltip()
            .onChange(async (intensity) => {
              await this.changeSharedSetting(
                {
                  kind: 'set-virtual-link-style',
                  mode: this.ensureVirtualLinks().colorMode,
                  intensity,
                },
                () => { this.ensureVirtualLinks().colorIntensity = intensity; },
              );
            }));
        },
      },
    ];

    return [
      {
        type: 'group',
        heading: 'Shared configuration',
        items: sharedConfigurationItems,
      },
      {
        type: 'group',
        heading: virtualLinkerInstalled
          ? 'Cross-vault virtual links (Virtual Linker)'
          : 'Cross-vault virtual links (requires Virtual Linker)',
        items: virtualLinkerItems,
      },
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
                      const vault = {
                        id: `vault-${Date.now()}`,
                        name,
                        path: this.newVaultPath,
                        enabled: true,
                      };
                      if (!this.vaultRegistry.validateVaultPath(vault.path)) {
                        new Notice(`Invalid vault path: ${vault.path}`);
                        return;
                      }
                      await this.changeSharedSetting(
                        {
                          kind: 'upsert-vault',
                          vault: {
                            ...vault,
                            path: normalizePathDisplay(vault.path, process.platform),
                            pathKey: normalizeExistingPathKey(vault.path, process.platform),
                          },
                        },
                        () => { this.vaultRegistry.addVault(vault); },
                      );
                      this.newVaultPath = "";
                      this.update();
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
        heading: 'Cross-Vault Links',
        items: [
          {
            name: "Show vault badge",
            desc: "Prefix [[vault::note]] links with a small badge showing the vault name. Applies in Reading View; re-open the note to see the change.",
            render: (setting: Setting) => {
              setting.addToggle(toggle => toggle
                .setValue(this.plugin.settings.showCrossVaultBadge !== false)
                .onChange(async (value) => {
                  await this.changeSharedSetting(
                    {
                      kind: 'set-cross-vault-appearance',
                      showBadge: value,
                      useColor: this.plugin.settings.useVaultColorForLinks,
                    },
                    () => { this.plugin.settings.showCrossVaultBadge = value; },
                  );
                })
              );
            }
          },
          {
            name: "Use vault color for links",
            desc: "Color each cross-vault link with the color configured for its vault above. Vaults without a color keep the theme's link color. Applies in Reading View; re-open the note to see the change.",
            render: (setting: Setting) => {
              setting.addToggle(toggle => toggle
                .setValue(this.plugin.settings.useVaultColorForLinks === true)
                .onChange(async (value) => {
                  await this.changeSharedSetting(
                    {
                      kind: 'set-cross-vault-appearance',
                      showBadge: this.plugin.settings.showCrossVaultBadge,
                      useColor: value,
                    },
                    () => { this.plugin.settings.useVaultColorForLinks = value; },
                  );
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

  /** Obsidian does not expose the plugin registry in its typings, so probe it structurally. */
  private isVirtualLinkerInstalled(): boolean {
    const registry = (this.app as unknown as {
      plugins?: { plugins?: Record<string, unknown>; enabledPlugins?: Set<string> };
    }).plugins;
    return registry?.plugins?.[VIRTUAL_LINKER_PLUGIN_ID] !== undefined
      || registry?.enabledPlugins?.has(VIRTUAL_LINKER_PLUGIN_ID) === true;
  }

  private ensureVirtualLinks(): NonNullable<typeof this.plugin.settings.virtualLinks> {
    if (!this.plugin.settings.virtualLinks) {
      this.plugin.settings.virtualLinks = {
        enabled: false,
        excludedSourceVaultIds: [],
        targetVaultIdsBySource: {},
        colorMode: 'soft-pill',
        colorIntensity: 55,
      };
    }
    return this.plugin.settings.virtualLinks;
  }

  private virtualLinkIntensity(): number {
    const intensity = this.ensureVirtualLinks().colorIntensity;
    return Number.isInteger(intensity) ? Math.min(90, Math.max(10, intensity)) : 55;
  }

  private async changeSharedSetting(
    patch: SharedSettingsPatch,
    changeLocalSetting: () => void,
  ): Promise<void> {
    const service = this.plugin.sharedSettingsService;
    if (service?.getStatus().enabled) {
      const result = await service.publish(patch);
      if (result.kind === 'error') {
        new Notice(`Shared configuration change failed: ${result.message}`);
      } else if (result.kind === 'excluded') {
        new Notice('This vault is excluded and cannot publish shared configuration changes.');
      } else if (result.kind === 'disabled') {
        new Notice('Shared configuration is disabled.');
      }
      return;
    }

    changeLocalSetting();
    await this.plugin.saveSettings();
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
