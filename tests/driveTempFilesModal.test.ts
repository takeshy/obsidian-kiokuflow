import { beforeEach, describe, expect, it, vi } from "vitest";
import type { App } from "obsidian";
import type { DriveSyncManager, TempFilePayload } from "../src/core/driveSync";
import type { DriveFile } from "../src/core/googleDrive";
vi.mock("../src/ui/components/ConfirmModal", () => ({ ConfirmModal: class { async openAndWait() { return true; } } }));
import { DriveTempFilesModal } from "../src/ui/components/DriveTempFilesModal";

type ModalState = {
  entries: DriveFile[]; selected: Set<string>; preview: { id: string; payload?: TempFilePayload; error?: string } | null;
  render(): void; togglePreview(id: string): Promise<void>; confirmAndApply(): Promise<void>; confirmAndDelete(): Promise<void>;
};
const payload = (id: string): TempFilePayload => ({ fileId: id, filePath: id + ".md", content: "body-" + id, savedAt: "", isBinary: false });
function fixture() {
  const api = {
    listTempFiles: vi.fn(async () => ["a", "b", "c"].map(id => ({ id, name: id + ".md", mimeType: "application/json" }))),
    readTempFile: vi.fn(async (id: string) => payload(id)),
    downloadTempToVault: vi.fn(async (_id: string, _payload: TempFilePayload) => {}), deleteTempFiles: vi.fn(async (ids: string[]) => ids.length),
  };
  const done = vi.fn();
  const modal = new DriveTempFilesModal({} as App, api as unknown as DriveSyncManager, done);
  Object.assign(modal, { contentEl: { empty: vi.fn() } });
  const state = modal as unknown as ModalState;
  const render = vi.spyOn(state, "render").mockImplementation(() => {});
  return { modal, state, api, done, render };
}
beforeEach(() => vi.restoreAllMocks());
describe("temporary files modal", () => {
  it("opens using metadata and keeps only the active preview payload", async () => {
    const { modal, state, api } = fixture(); modal.onOpen();
    await vi.waitFor(() => expect(state.entries).toHaveLength(3));
    expect(api.readTempFile).not.toHaveBeenCalled();
    await state.togglePreview("a"); expect(state.preview?.payload?.fileId).toBe("a");
    await state.togglePreview("b"); expect(state.preview?.payload?.fileId).toBe("b");
    expect(state.entries.every(file => !("payload" in file))).toBe(true);
    await state.togglePreview("b"); expect(state.preview).toBeNull();
  });
  it("discards a slow response after switching previews or closing", async () => {
    const { modal, state, api, render } = fixture();
    let resolve!: (value: TempFilePayload) => void;
    api.readTempFile.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    const first = state.togglePreview("a"); await state.togglePreview("b");
    resolve(payload("a")); await first; expect(state.preview?.id).toBe("b");
    api.readTempFile.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    const second = state.togglePreview("c"); modal.onClose(); render.mockClear();
    resolve(payload("c")); await second; expect(state.preview).toBeNull(); expect(render).not.toHaveBeenCalled();
  });
  it("applies only selected files, reading and applying each before fetching the next", async () => {
    const { state, api, done } = fixture(); const order: string[] = [];
    api.readTempFile.mockImplementation(async id => { order.push("read-" + id); return payload(id); });
    api.downloadTempToVault.mockImplementation(async (...args: unknown[]) => { order.push("apply-" + String(args[0])); });
    state.selected.add("a"); state.selected.add("c"); await state.confirmAndApply();
    expect(order).toEqual(["read-a", "apply-a", "read-c", "apply-c"]); expect(done).toHaveBeenCalledOnce();
    expect(state.preview).toBeNull();
  });
  it("does not read payloads when deleting selected files", async () => {
    const { state, api } = fixture(); state.selected.add("b"); await state.confirmAndDelete();
    expect(api.deleteTempFiles).toHaveBeenCalledWith(["b"]); expect(api.readTempFile).not.toHaveBeenCalled();
  });
  it("retains a preview error so it can be retried, and continues applying after one failure", async () => {
    const { state, api } = fixture(); api.readTempFile.mockRejectedValueOnce(new Error("offline"));
    await state.togglePreview("a"); expect(state.preview?.error).toContain("offline");
    state.selected.add("a"); state.selected.add("b"); api.readTempFile.mockRejectedValueOnce(new Error("invalid"));
    await state.confirmAndApply(); expect(api.downloadTempToVault).toHaveBeenCalledOnce();
    expect(api.downloadTempToVault.mock.calls[0]?.[0]).toBe("b");
  });
});
