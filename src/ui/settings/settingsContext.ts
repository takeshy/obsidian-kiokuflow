import type { KiokuflowPlugin } from "src/plugin";

export interface SettingsContext {
  plugin: KiokuflowPlugin;
  display: () => void;
}
