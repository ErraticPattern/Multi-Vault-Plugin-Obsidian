import { App, Modal, Setting } from 'obsidian';

import type { SharedSettingsStatus } from '../shared-settings/shared-settings-service';

export interface SharedStatusModel {
  path: string;
  enabled: string;
  revision: string;
  lastAppliedRevision: string;
  lastAppliedAt: string;
  exclusion: string;
  error: string;
}

export function makeSharedStatusModel(status: SharedSettingsStatus): SharedStatusModel {
  return {
    path: status.path,
    enabled: status.enabled ? 'Enabled' : 'Disabled',
    revision: status.revision === null ? 'Not initialized' : String(status.revision),
    lastAppliedRevision: status.lastAppliedRevision === null ? 'Never' : String(status.lastAppliedRevision),
    lastAppliedAt: status.lastAppliedAt ?? 'Never',
    exclusion: status.excluded ? 'Excluded from synchronization' : 'Participating',
    error: status.error ?? 'None',
  };
}

export class SharedSettingsStatusModal extends Modal {
  constructor(app: App, private readonly status: SharedSettingsStatus) {
    super(app);
  }

  onOpen(): void {
    const model = makeSharedStatusModel(this.status);
    this.contentEl.empty();
    this.contentEl.createEl('h2', { text: 'Shared configuration status' });
    new Setting(this.contentEl).setName('State').setDesc(model.enabled);
    new Setting(this.contentEl).setName('Current revision').setDesc(model.revision);
    new Setting(this.contentEl).setName('Last applied revision').setDesc(model.lastAppliedRevision);
    new Setting(this.contentEl).setName('Last application time').setDesc(model.lastAppliedAt);
    new Setting(this.contentEl).setName('Current vault').setDesc(model.exclusion);
    new Setting(this.contentEl).setName('Journal path').setDesc(model.path);
    new Setting(this.contentEl).setName('Last error').setDesc(model.error);
  }
}
