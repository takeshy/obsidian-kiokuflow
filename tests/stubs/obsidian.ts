// Minimal runtime stub for the "obsidian" module.
//
// The published package ships types plus a shim that only works inside the
// Obsidian app, so tests alias the module here (see vitest.config.ts). Only the
// members the code under test actually touches at runtime are implemented.

export class TAbstractFile {
  path: string;
  name: string;
  constructor(path: string) {
    this.path = path;
    this.name = path.slice(path.lastIndexOf("/") + 1);
  }
}

export class TFile extends TAbstractFile {
  stat: { mtime: number; size: number; ctime: number };
  extension: string;
  constructor(path: string, stat?: { mtime: number; size: number }) {
    super(path);
    const mtime = stat?.mtime ?? 0;
    this.stat = { mtime, size: stat?.size ?? 0, ctime: mtime };
    const dot = this.name.lastIndexOf(".");
    this.extension = dot > 0 ? this.name.slice(dot + 1) : "";
  }
}

export class TFolder extends TAbstractFile {
  children: TAbstractFile[] = [];
}

/** Captures notices so tests can assert on user-facing messages. */
export const notices: string[] = [];

export class Notice {
  constructor(message: string) {
    notices.push(message);
  }
  setMessage(): this {
    return this;
  }
  hide(): void {
    /* no-op */
  }
}

export const Platform = { isMobile: false, isDesktop: true };

export function requestUrl(): never {
  throw new Error("requestUrl is not available in tests; mock the Drive module instead.");
}

export class Modal {}
export class Setting {}
export class App {}
export class Plugin {}
export class PluginSettingTab {}
export function normalizePath(path: string): string {
  return path.replace(/\/+/g, "/").replace(/^\/+|\/+$/g, "");
}
export type EventRef = unknown;
export type DataAdapter = unknown;
export type Vault = unknown;
