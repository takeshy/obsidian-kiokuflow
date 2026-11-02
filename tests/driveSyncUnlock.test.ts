import { beforeEach, describe, expect, it, vi } from "vitest";
import type { KiokuflowPlugin } from "../src/plugin";
import { DriveSyncUIManager } from "../src/plugin/driveSyncUI";

const { prompt } = vi.hoisted(() => ({ prompt: vi.fn() }));
vi.mock("../src/ui/components/DriveAuthPasswordModal", () => ({
  DriveAuthPasswordModal: class {
    openAndWait = prompt;
  },
}));

function setup(secretId = "gemihub-password") {
  const mgr = {
    isConfigured: true,
    isUnlocked: false,
    unlockWithPassword: vi.fn(async (_password: string) => { mgr.isUnlocked = true; }),
    lock: vi.fn(() => { mgr.isUnlocked = false; }),
  };
  const getSecret = vi.fn<() => string | null>(() => "saved-password");
  const plugin = {
    app: { secretStorage: { getSecret, setSecret: vi.fn() } },
    saveSettings: vi.fn(async () => undefined),
    settings: { driveSync: { passwordSecretId: secretId } },
    driveSyncManager: mgr,
  } as unknown as KiokuflowPlugin;
  return { mgr, getSecret, plugin, ui: new DriveSyncUIManager(plugin) };
}

beforeEach(() => {
  prompt.mockReset().mockResolvedValue(null);
});

describe("Drive sync Secret Storage unlock", () => {
  it("unlocks with the selected secret without prompting", async () => {
    const { ui, mgr, getSecret } = setup();
    await ui.promptDriveSyncUnlock();
    expect(getSecret).toHaveBeenCalledWith("gemihub-password");
    expect(mgr.unlockWithPassword).toHaveBeenCalledWith("saved-password");
    expect(prompt).not.toHaveBeenCalled();
  });

  it("uses manual entry when no secret is selected", async () => {
    const { ui, mgr, getSecret } = setup("");
    prompt.mockResolvedValueOnce({ password: "manual-password", savePassword: false });
    await ui.promptDriveSyncUnlock();
    expect(getSecret).not.toHaveBeenCalled();
    expect(mgr.unlockWithPassword).toHaveBeenCalledWith("manual-password");
  });

  it("prompts when the selected secret is missing and allows cancellation", async () => {
    const { ui, mgr, getSecret } = setup();
    getSecret.mockReturnValue(null);
    await ui.promptDriveSyncUnlock();
    expect(prompt).toHaveBeenCalledOnce();
    expect(mgr.unlockWithPassword).not.toHaveBeenCalled();
  });

  it("falls back to manual entry after a failed automatic unlock", async () => {
    const { ui, mgr } = setup();
    mgr.unlockWithPassword.mockImplementationOnce(async () => {
      mgr.isUnlocked = true;
      throw new Error("Unlock failed after obtaining tokens");
    });
    prompt.mockResolvedValueOnce({ password: "corrected-password", savePassword: false });
    await ui.promptDriveSyncUnlock();
    expect(mgr.lock).toHaveBeenCalledOnce();
    expect(mgr.unlockWithPassword.mock.calls).toEqual([["saved-password"], ["corrected-password"]]);
    expect(mgr.isUnlocked).toBe(true);
  });

  it("falls back if Secret Storage cannot be read", async () => {
    const { ui, getSecret } = setup();
    getSecret.mockImplementation(() => { throw new Error("Storage unavailable"); });
    await ui.promptDriveSyncUnlock();
    expect(prompt).toHaveBeenCalledOnce();
  });

  it("shares an in-progress unlock between concurrent callers", async () => {
    const { ui, mgr } = setup();
    await Promise.all([ui.promptDriveSyncUnlock(), ui.promptDriveSyncUnlock()]);
    expect(mgr.unlockWithPassword).toHaveBeenCalledOnce();
  });

  it("does not read credentials while disabled or already unlocked", async () => {
    const { ui, mgr, getSecret } = setup();
    mgr.isConfigured = false;
    await ui.promptDriveSyncUnlock();
    mgr.isConfigured = true;
    mgr.isUnlocked = true;
    await ui.promptDriveSyncUnlock();
    expect(getSecret).not.toHaveBeenCalled();
    expect(prompt).not.toHaveBeenCalled();
  });

  it("stores a verified password and automatically unlocks next time", async () => {
    const { ui, mgr, plugin, getSecret } = setup("");
    prompt.mockResolvedValueOnce({ password: "verified-password", savePassword: true });
    await ui.promptDriveSyncUnlock();
    const id = plugin.settings.driveSync.passwordSecretId;
    expect(id).toMatch(/^kiokuflow-drive-password-/);
    expect(plugin.app.secretStorage.setSecret).toHaveBeenCalledWith(id, "verified-password");
    expect(plugin.saveSettings).toHaveBeenCalledOnce();
    expect(JSON.stringify(plugin.settings)).not.toContain("verified-password");
    mgr.isUnlocked = false;
    getSecret.mockReturnValue("verified-password");
    await ui.promptDriveSyncUnlock();
    expect(prompt).toHaveBeenCalledOnce();
    expect(mgr.unlockWithPassword).toHaveBeenLastCalledWith("verified-password");
  });

  it("does not save when the user opts out", async () => {
    const { ui, plugin } = setup("");
    prompt.mockResolvedValueOnce({ password: "manual-password", savePassword: false });
    await ui.promptDriveSyncUnlock();
    expect(plugin.app.secretStorage.setSecret).not.toHaveBeenCalled();
    expect(plugin.saveSettings).not.toHaveBeenCalled();
  });

  it("does not store a password that fails authentication", async () => {
    const { ui, mgr, plugin } = setup("");
    mgr.unlockWithPassword.mockRejectedValueOnce(new Error("Incorrect password"));
    prompt.mockResolvedValueOnce({ password: "wrong-password", savePassword: true });
    await ui.promptDriveSyncUnlock();
    expect(plugin.app.secretStorage.setSecret).not.toHaveBeenCalled();
    expect(plugin.saveSettings).not.toHaveBeenCalled();
  });

  it("updates the selected secret after correcting its password", async () => {
    const { ui, mgr, plugin } = setup();
    mgr.unlockWithPassword.mockRejectedValueOnce(new Error("Old password"));
    prompt.mockResolvedValueOnce({ password: "updated-password", savePassword: true });
    await ui.promptDriveSyncUnlock();
    expect(plugin.app.secretStorage.setSecret).toHaveBeenCalledWith("gemihub-password", "updated-password");
  });

  it("keeps the session unlocked if saving the password fails", async () => {
    const { ui, mgr, plugin } = setup("");
    vi.mocked(plugin.app.secretStorage.setSecret).mockImplementation(() => { throw new Error("Storage unavailable"); });
    prompt.mockResolvedValueOnce({ password: "verified-password", savePassword: true });
    await ui.promptDriveSyncUnlock();
    expect(mgr.isUnlocked).toBe(true);
    expect(plugin.settings.driveSync.passwordSecretId).toBe("");
    expect(prompt).toHaveBeenCalledOnce();
  });

});
