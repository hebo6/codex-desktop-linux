import { describe, expect, it, vi } from "vitest";

import { createPreferencesStore, DEFAULT_APP_PREFERENCES, parsePreferences } from "./preferences";
import type { TauriIpc } from "./tauriIpc";

describe("preferences transport", () => {
  it("缺失字段使用稳定默认值", () => {
    expect(parsePreferences({ theme: "dark", enterToSend: false })).toEqual({
      ...DEFAULT_APP_PREFERENCES,
      theme: "dark",
    });
  });

  it("只接受可用范围内的整数侧栏宽度", () => {
    expect(parsePreferences({ sidebarWidth: 360 }).sidebarWidth).toBe(360);
    expect(parsePreferences({ sidebarWidth: 100 }).sidebarWidth).toBe(288);
    expect(parsePreferences({ sidebarWidth: 300.5 }).sidebarWidth).toBe(288);
  });

  it("通过受限命令读写偏好并读取诊断", async () => {
    const invoke = vi.fn(async (command: string) => command === "read_system_diagnostics"
      ? { clientVersion: "0.1.0", protocolBaseline: "abc", operatingSystem: "linux", architecture: "x86_64", webviewVersion: "2.48.1", sessionType: null, desktop: null }
      : {});
    const store = createPreferencesStore({ invoke } as Pick<TauriIpc, "invoke">);
    await store.load();
    await store.save(DEFAULT_APP_PREFERENCES);
    await store.clearThreadCache();
    await store.clearApplicationLogs();
    await store.clearTemporaryFiles();
    await store.clearAllLocalData();
    await store.readDiagnostics();
    expect(invoke.mock.calls.map(([command]) => command)).toEqual([
      "load_preferences",
      "save_preferences",
      "clear_thread_cache",
      "clear_application_logs",
      "clear_temporary_files",
      "clear_all_local_data",
      "read_system_diagnostics",
    ]);
  });
});
