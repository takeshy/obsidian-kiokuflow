// In-memory stand-in for Obsidian's App/Vault/DataAdapter.
//
// Only the surface the sync engine uses is implemented. Every mutation is
// counted so tests can assert on how much work a code path does, which is the
// whole point for batch conflict resolution.

import { TFile, TFolder, type TAbstractFile } from "../stubs/obsidian";

export interface FakeVaultCounters {
  read: number;
  readBinary: number;
  write: number;
  writeBinary: number;
  stat: number;
  list: number;
  mkdir: number;
  remove: number;
}

function toArrayBuffer(text: string): ArrayBuffer {
  return new TextEncoder().encode(text).buffer as ArrayBuffer;
}

function fromArrayBuffer(buf: ArrayBuffer): string {
  return new TextDecoder().decode(new Uint8Array(buf));
}

export class FakeVault {
  /** path -> content. Text files are stored as strings, binaries as buffers. */
  private files = new Map<string, string | ArrayBuffer>();
  private mtimes = new Map<string, number>();
  private folders = new Set<string>();
  private clock = 1_000;

  readonly counters: FakeVaultCounters = {
    read: 0, readBinary: 0, write: 0, writeBinary: 0,
    stat: 0, list: 0, mkdir: 0, remove: 0,
  };

  configDir = ".obsidian";

  constructor(initial: Record<string, string> = {}) {
    for (const [path, content] of Object.entries(initial)) this.setFile(path, content);
  }

  // ---- test-facing helpers -------------------------------------------------

  /** Seed or overwrite a file without touching the counters. */
  setFile(path: string, content: string | ArrayBuffer): void {
    this.files.set(path, content);
    this.mtimes.set(path, this.clock++);
    this.ensureParentFolders(path);
  }

  getFile(path: string): string | undefined {
    const content = this.files.get(path);
    if (content === undefined) return undefined;
    return typeof content === "string" ? content : fromArrayBuffer(content);
  }

  has(path: string): boolean {
    return this.files.has(path);
  }

  /** All file paths under a folder prefix, sorted. */
  pathsUnder(prefix: string): string[] {
    return [...this.files.keys()].filter((p) => p.startsWith(prefix)).sort();
  }

  resetCounters(): void {
    for (const key of Object.keys(this.counters) as (keyof FakeVaultCounters)[]) {
      this.counters[key] = 0;
    }
  }

  private ensureParentFolders(path: string): void {
    const parts = path.split("/").slice(0, -1);
    let current = "";
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      this.folders.add(current);
    }
  }

  // ---- DataAdapter ---------------------------------------------------------

  readonly adapter = {
    exists: async (path: string): Promise<boolean> =>
      this.files.has(path) || this.folders.has(path),

    read: async (path: string): Promise<string> => {
      this.counters.read++;
      const content = this.files.get(path);
      if (content === undefined) throw new Error(`ENOENT: ${path}`);
      return typeof content === "string" ? content : fromArrayBuffer(content);
    },

    readBinary: async (path: string): Promise<ArrayBuffer> => {
      this.counters.readBinary++;
      const content = this.files.get(path);
      if (content === undefined) throw new Error(`ENOENT: ${path}`);
      return typeof content === "string" ? toArrayBuffer(content) : content;
    },

    write: async (path: string, content: string): Promise<void> => {
      this.counters.write++;
      this.setFile(path, content);
    },

    writeBinary: async (path: string, content: ArrayBuffer): Promise<void> => {
      this.counters.writeBinary++;
      this.setFile(path, content);
    },

    mkdir: async (path: string): Promise<void> => {
      this.counters.mkdir++;
      if (this.folders.has(path)) throw new Error(`EEXIST: ${path}`);
      this.folders.add(path);
    },

    rename: async (source: string, destination: string): Promise<void> => {
      if (this.files.has(destination) || this.folders.has(destination)) throw new Error(`EEXIST: ${destination}`);
      if (!this.files.has(source) && !this.folders.has(source)) throw new Error(`ENOENT: ${source}`);
      const translate = (path: string) => destination + path.slice(source.length);
      for (const [path, content] of [...this.files]) {
        if (path !== source && !path.startsWith(`${source}/`)) continue;
        this.files.set(translate(path), content);
        this.mtimes.set(translate(path), this.mtimes.get(path)!);
        this.files.delete(path);
        this.mtimes.delete(path);
      }
      for (const path of [...this.folders]) {
        if (path !== source && !path.startsWith(`${source}/`)) continue;
        this.folders.delete(path);
        this.folders.add(translate(path));
      }
      this.ensureParentFolders(destination);
    },

    rmdir: async (path: string, recursive: boolean): Promise<void> => {
      if (recursive || [...this.files.keys(), ...this.folders].some(child => child.startsWith(`${path}/`))) {
        throw new Error(`Directory must be empty: ${path}`);
      }
      if (!this.folders.delete(path)) throw new Error(`ENOENT: ${path}`);
    },

    stat: async (path: string) => {
      this.counters.stat++;
      if (this.folders.has(path)) return { type: "folder" as const, mtime: 0, size: 0, ctime: 0 };
      const content = this.files.get(path);
      if (content === undefined) return null;
      const size = typeof content === "string" ? content.length : content.byteLength;
      const mtime = this.mtimes.get(path) ?? 0;
      return { type: "file" as const, mtime, size, ctime: mtime };
    },

    list: async (dir: string) => {
      this.counters.list++;
      const prefix = dir === "/" || dir === "" ? "" : `${dir}/`;
      const files: string[] = [];
      const folders: string[] = [];
      for (const path of this.files.keys()) {
        if (!path.startsWith(prefix)) continue;
        if (path.slice(prefix.length).includes("/")) continue;
        files.push(path);
      }
      for (const folder of this.folders) {
        if (!folder.startsWith(prefix) || folder === dir) continue;
        if (folder.slice(prefix.length).includes("/")) continue;
        folders.push(folder);
      }
      return { files: files.sort(), folders: folders.sort() };
    },

    remove: async (path: string): Promise<void> => {
      this.counters.remove++;
      if (!this.files.delete(path)) throw new Error(`ENOENT: ${path}`);
      this.mtimes.delete(path);
    },

    trashLocal: async (path: string): Promise<void> => {
      const content = this.files.get(path);
      if (content === undefined) throw new Error(`ENOENT: ${path}`);
      this.files.delete(path);
      this.mtimes.delete(path);
      this.setFile(`.trash/${path.split("/").pop()}`, content);
    },
  };

  // ---- Vault ---------------------------------------------------------------

  read = async (file: TFile): Promise<string> => this.adapter.read(file.path);

  rename = async (file: TAbstractFile, destination: string): Promise<void> => this.adapter.rename(file.path, destination);

  delete = async (file: TAbstractFile): Promise<void> => {
    if (file instanceof TFolder) await this.adapter.rmdir(file.path, false);
    else await this.adapter.remove(file.path);
  };

  getAbstractFileByPath = (path: string): TAbstractFile | null => {
    if (this.files.has(path)) {
      const content = this.files.get(path)!;
      return new TFile(path, {
        mtime: this.mtimes.get(path) ?? 0,
        size: typeof content === "string" ? content.length : content.byteLength,
      });
    }
    if (this.folders.has(path)) return new TFolder(path);
    return null;
  };

  create = async (path: string, content: string): Promise<TFile> => {
    if (this.files.has(path)) throw new Error(`EEXIST: ${path}`);
    await this.adapter.write(path, content);
    return this.getAbstractFileByPath(path) as TFile;
  };

  createBinary = async (path: string, content: ArrayBuffer): Promise<TFile> => {
    if (this.files.has(path)) throw new Error(`EEXIST: ${path}`);
    await this.adapter.writeBinary(path, content);
    return this.getAbstractFileByPath(path) as TFile;
  };

  modify = async (file: TFile, content: string): Promise<void> => {
    await this.adapter.write(file.path, content);
  };

  modifyBinary = async (file: TFile, content: ArrayBuffer): Promise<void> => {
    await this.adapter.writeBinary(file.path, content);
  };

  createFolder = async (path: string): Promise<TFolder> => {
    await this.adapter.mkdir(path);
    return new TFolder(path);
  };

  /** Files that Obsidian's own trash handling removed. */
  readonly trashed: string[] = [];

  trashFile = async (file: TAbstractFile): Promise<void> => {
    this.trashed.push(file.path);
    this.files.delete(file.path);
    this.mtimes.delete(file.path);
  };
}

/** Build an object shaped like Obsidian's App around a FakeVault. */
export function createFakeApp(vault: FakeVault) {
  return {
    vault: {
      adapter: vault.adapter,
      configDir: vault.configDir,
      getAbstractFileByPath: vault.getAbstractFileByPath,
      read: vault.read,
      rename: vault.rename,
      delete: vault.delete,
      create: vault.create,
      createBinary: vault.createBinary,
      modify: vault.modify,
      modifyBinary: vault.modifyBinary,
      createFolder: vault.createFolder,
    },
    fileManager: {
      trashFile: vault.trashFile,
    },
  };
}
