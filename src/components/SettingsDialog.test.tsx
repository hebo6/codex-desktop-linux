import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { ProxyId, ProxyProfile, ServerId, ServerProfile } from "../configuration";
import { DEFAULT_APP_PREFERENCES, type PreferencesStore } from "../transport/preferences";
import { SettingsDialog } from "./SettingsDialog";

function renderSettings(overrides: Partial<Parameters<typeof SettingsDialog>[0]> = {}) {
  const store: PreferencesStore = {
    load: vi.fn(async () => DEFAULT_APP_PREFERENCES),
    save: vi.fn(async (value) => value),
    clearApplicationLogs: vi.fn(async () => undefined),
    clearTemporaryFiles: vi.fn(async () => undefined),
    clearAllLocalData: vi.fn(async () => undefined),
    readDiagnostics: vi.fn(async () => ({
      clientVersion: "0.1.0",
      protocolBaseline: "abc123",
      operatingSystem: "linux",
      architecture: "x86_64",
      webviewVersion: "2.48.1",
      sessionType: "wayland",
      desktop: "GNOME",
    })),
  };
  const props: Parameters<typeof SettingsDialog>[0] = {
    open: true,
    preferences: DEFAULT_APP_PREFERENCES,
    preferencesError: null,
    preferencesLoading: false,
    preferencesSaving: false,
    preferencesStore: store,
    servers: [],
    proxies: [],
    permissionProfiles: [],
    connectionPhase: "ready",
    currentConnectionStage: null,
    recentConnectionError: null,
    currentServer: null,
    currentServerName: "本机开发",
    serverConnectionViews: {},
    onClose: vi.fn(),
    onEditServer: vi.fn(),
    onNewServer: vi.fn(),
    onConnectServer: vi.fn(),
    onOpenServerInNewWindow: vi.fn(),
    onDeleteServer: vi.fn(),
    onEditProxy: vi.fn(),
    onNewProxy: vi.fn(),
    onDeleteProxy: vi.fn(),
    onUpdatePreferences: vi.fn(),
    notificationPermission: "granted",
    onBeforeClearAllLocalData: vi.fn(async () => undefined),
    onAllLocalDataCleared: vi.fn(),
    ...overrides,
  };
  render(<SettingsDialog {...props} />);
  return { props, store };
}

describe("SettingsDialog", () => {
  it("提供全部 P0 分区并立即提交主题选择", () => {
    const { props } = renderSettings();
    expect(screen.getAllByRole("button", { name: /外观|通用|通知|服务器|代理|权限|数据与隐私|快捷键|诊断/u })).toHaveLength(9);
    fireEvent.click(screen.getByRole("radio", { name: "深色" }));
    expect(props.onUpdatePreferences).toHaveBeenCalledWith({ theme: "dark" });
  });

  it("分别清理日志、临时文件和包含草稿的全部本地数据", async () => {
    const { props, store } = renderSettings({ initialSection: "privacy" });

    for (const [buttonName, confirmation, operation] of [
      ["清理日志", "确认清理日志", store.clearApplicationLogs],
      ["清理临时文件", "确认清理临时文件", store.clearTemporaryFiles],
    ] as const) {
      fireEvent.click(screen.getByRole("button", { name: buttonName }));
      fireEvent.click(screen.getByRole("button", { name: confirmation }));
      await waitFor(() => expect(operation).toHaveBeenCalledTimes(1));
    }

    fireEvent.click(screen.getByRole("button", { name: "清理全部本地数据" }));
    expect(screen.getByText(/凭据存储中的凭据/u)).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "确认清理全部本地数据" }));
    await waitFor(() => expect(store.clearAllLocalData).toHaveBeenCalledTimes(1));
    expect(props.onBeforeClearAllLocalData).toHaveBeenCalledTimes(1);
    expect(props.onAllLocalDataCleared).toHaveBeenCalledTimes(1);
  });

  it("服务器分区复用连接、新窗口、编辑和删除业务入口", () => {
    const serverId = "22222222-2222-4222-8222-222222222222" as ServerId;
    const server: ServerProfile = {
      serverId,
      name: "共享工作区",
      version: 1,
      configuration: {
        type: "localStdio",
        executablePath: "/usr/bin/codex",
        arguments: ["app-server"],
        nonSensitiveEnvironment: {},
      },
      credentialConfigured: false,
      activeWindowCount: 0,
      createdAtMs: 1,
      updatedAtMs: 1,
    };
    const { props } = renderSettings({
      initialSection: "servers",
      servers: [server],
      serverConnectionViews: {
        [serverId]: { phase: "ready", errorSummary: null },
      },
    });

    expect(screen.getByText(/本机 stdio · 已连接/u)).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "切换" }));
    fireEvent.click(screen.getByRole("button", { name: "新窗口" }));
    fireEvent.click(screen.getByRole("button", { name: "编辑" }));
    fireEvent.click(screen.getByRole("button", { name: "删除" }));
    expect(props.onConnectServer).toHaveBeenCalledWith(serverId);
    expect(props.onOpenServerInNewWindow).toHaveBeenCalledWith(serverId);
    expect(props.onEditServer).toHaveBeenCalledWith(serverId);
    expect(props.onDeleteServer).toHaveBeenCalledWith(serverId);
  });

  it("只在打开诊断分区后读取脱敏报告", async () => {
    const proxyId = "11111111-1111-4111-8111-111111111111" as ProxyId;
    const server: ServerProfile = {
      serverId: "22222222-2222-4222-8222-222222222222" as ServerId,
      name: "远程工作区",
      version: 1,
      configuration: {
        type: "remoteWebSocket",
        url: "wss://codex.example.test/app-server",
        authentication: "none",
        nonSensitiveHeaders: {},
        proxyId,
        connectTimeoutMs: 30_000,
        tlsCertificatePolicy: "strict",
        plaintextConfirmed: false,
      },
      credentialConfigured: false,
      activeWindowCount: 1,
      createdAtMs: 1,
      updatedAtMs: 1,
    };
    const proxy: ProxyProfile = {
      proxyId,
      name: "共享代理",
      version: 1,
      configuration: {
        type: "socks5",
        host: "proxy.example.test",
        port: 1080,
        authentication: "none",
        dnsResolution: "proxy",
        connectTimeoutMs: 30_000,
      },
      credentialConfigured: false,
      referencedServerCount: 1,
      createdAtMs: 1,
      updatedAtMs: 1,
    };
    const { store } = renderSettings({
      initialSection: "diagnostics",
      currentServer: server,
      currentServerName: server.name,
      proxies: [proxy],
      servers: [server],
      connectionPhase: "error",
      currentConnectionStage: "建立隧道",
      recentConnectionError: "代理认证失败",
    });
    await waitFor(() => expect(store.readDiagnostics).toHaveBeenCalledTimes(1));
    expect(screen.getByText(/Codex Desktop Linux 0\.1\.0/u)).toBeVisible();
    expect(screen.getByText(/协议基线 abc123/u)).toBeVisible();
    expect(screen.getByText(/代理类型 SOCKS5/u)).toBeVisible();
    expect(screen.getByText(/当前阶段 建立隧道/u)).toBeVisible();
    expect(screen.getByText(/最近错误 代理认证失败/u)).toBeVisible();
    expect(screen.getByText(/会话恢复耗时 当前进程暂无记录/u)).toBeVisible();
  });
});
