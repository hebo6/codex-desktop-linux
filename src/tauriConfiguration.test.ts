import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import tauriConfiguration from "../src-tauri/tauri.conf.json";
import eventCapability from "../src-tauri/capabilities/app-events.json";
import protocolDebugCapability from "../src-tauri/capabilities/protocol-debug.json";

const windowPermission = readFileSync(
  "src-tauri/permissions/window.toml",
  "utf8",
);

describe("Tauri 发布配置", () => {
  it("保留由前端封装间接调用的 IPC 命令", () => {
    expect(tauriConfiguration.build.removeUnusedCommands).toBe(false);
  });

  it("允许应用窗口更新标签状态", () => {
    expect(windowPermission).toContain('"update_window_tabs"');
    expect(windowPermission).not.toContain('"update_window_session"');
  });

  it("允许应用窗口管理草稿", () => {
    for (const command of [
      "list_draft_keys",
      "load_draft",
      "save_draft",
      "transition_draft",
      "delete_draft",
    ]) {
      expect(windowPermission).toContain(`"${command}"`);
    }
  });

  it("允许应用窗口读取明确粘贴的本机文件", () => {
    expect(windowPermission).toContain('"read_clipboard_files"');
    expect(windowPermission).toContain('"read_clipboard_file_chunk"');
  });

  it("允许应用窗口将 HTML 交给系统浏览器", () => {
    expect(windowPermission).toContain('"open_html_in_browser"');
  });

  it("不允许应用内 HTML 子框架和 Blob 样式资源", () => {
    const csp = tauriConfiguration.app.security.csp;
    expect(csp).not.toContain("frame-src");
    expect(csp).toContain("font-src 'self'");
    expect(csp).toContain("style-src 'self'");
    expect(csp).not.toMatch(/(?:font|style)-src[^;]*blob:/u);
    expect(csp).not.toContain("'unsafe-inline'");
  });

  it("允许应用窗口订阅和退订应用事件", () => {
    expect(tauriConfiguration.app.security.capabilities).toContain("app-events");
    expect(eventCapability.windows).toEqual(["main", "app-*"]);
    expect(eventCapability.permissions).toEqual([
      "core:event:allow-listen",
      "core:event:allow-unlisten",
    ]);
  });

  it("仅向独立协议检查器窗口授予只读追踪和主题权限", () => {
    expect(tauriConfiguration.app.security.capabilities).toContain(
      "protocol-debug",
    );
    expect(protocolDebugCapability.windows).toEqual(["protocol-debug"]);
    expect(protocolDebugCapability.permissions).toContain(
      "allow-protocol-trace",
    );
    expect(protocolDebugCapability.permissions).toContain(
      "allow-load-theme-preference",
    );
    expect(protocolDebugCapability.permissions).not.toContain(
      "allow-open-app-window",
    );
    expect(protocolDebugCapability.permissions).not.toContain(
      "allow-send-configured-server-message",
    );
    expect(protocolDebugCapability.permissions).not.toContain(
      "allow-connect-configured-server",
    );
    expect(windowPermission).toContain('"open_protocol_debug_window"');
    expect(windowPermission).toContain('commands.allow = ["load_theme_preference"]');
    expect(windowPermission).not.toContain('"protocol_debug_availability"');
  });
});
