import { PluginSettingTab, App } from "obsidian";
import type { KiokuflowPlugin } from "src/plugin";
import type { SettingsContext } from "src/ui/settings/settingsContext";
import { displayDriveSyncSettings } from "src/ui/settings/driveSyncSettings";

export class SettingsTab extends PluginSettingTab {
  plugin: KiokuflowPlugin;

  constructor(app: App, plugin: KiokuflowPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    const ctx: SettingsContext = {
      plugin: this.plugin,
      display: () => this.display(),
    };

    displayDriveSyncSettings(containerEl, ctx);
  }
}
