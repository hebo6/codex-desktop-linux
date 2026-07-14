import { describe, expect, it } from "vitest";

import tauriConfiguration from "../src-tauri/tauri.conf.json";
import eventCapability from "../src-tauri/capabilities/app-events.json";

describe("Tauri 发布配置", () => {
  it("保留由前端封装间接调用的 IPC 命令", () => {
    expect(tauriConfiguration.build.removeUnusedCommands).toBe(false);
  });

  it("允许应用窗口订阅和退订应用事件", () => {
    expect(tauriConfiguration.app.security.capabilities).toContain("app-events");
    expect(eventCapability.windows).toEqual(["main", "app-*"]);
    expect(eventCapability.permissions).toEqual([
      "core:event:allow-listen",
      "core:event:allow-unlisten",
    ]);
  });
});
