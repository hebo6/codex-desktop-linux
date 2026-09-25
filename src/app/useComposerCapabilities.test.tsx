import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { CapabilityClient } from "../appServer";
import type {
  AppsListParams,
  AppsListResponse,
  PluginListResponse,
  ServerNotification,
} from "../protocol/generated";
import type { RequestHandle } from "../protocol/rpc";
import { useComposerCapabilities } from "./useComposerCapabilities";

function completed<T>(value: T): RequestHandle<T> {
  return {
    epoch: 1,
    id: crypto.randomUUID(),
    stage: "pending",
    result: Promise.resolve(value),
  };
}

describe("useComposerCapabilities", () => {
  it("应用推送优先于迟到的旧列表，并按技能变更重新查询", async () => {
    const listeners = new Set<(notification: ServerNotification) => void>();
    let finishApps!: (response: AppsListResponse) => void;
    const client = {
      listApps: () => ({ ...completed({ data: [] }), result: new Promise<AppsListResponse>((resolve) => { finishApps = resolve; }) }),
      listModels: () => completed({ data: [] }),
      listPermissionProfiles: () => completed({ data: [] }),
      listPlugins: () => completed({ marketplaces: [] }),
      listSkills: vi.fn(() => completed({ data: [] })),
      readConfig: () => completed({ config: {}, origins: {} }),
      readConfigRequirements: () => completed({ requirements: null }),
      searchFiles: () => completed({ files: [] }),
      writeConfigValue: () => completed({ filePath: "/config.toml", status: "ok", version: "v1" }),
    } satisfies CapabilityClient;
    const notifications = {
      subscribeNotifications: (listener: (notification: ServerNotification) => void) => {
        listeners.add(listener);
        return () => { listeners.delete(listener); };
      },
    };
    const { result } = renderHook(() => useComposerCapabilities(client, "/workspace", notifications));
    await waitFor(() => expect(result.current.defaultsLoading).toBe(false));
    let pending!: Promise<void>;
    act(() => { pending = result.current.loadMentions(); });
    act(() => {
      for (const listener of listeners) {
        listener({ method: "app/list/updated", params: { data: [{ id: "new", name: "New", isAccessible: true, isEnabled: true }] } });
        listener({ method: "skills/changed", params: {} });
      }
    });
    await act(async () => {
      finishApps({ data: [{ id: "old", name: "Old", isAccessible: true, isEnabled: true }] });
      await pending;
    });
    expect(result.current.mentionReferences.map(({ name }) => name)).toEqual(["New"]);
    expect(client.listSkills).toHaveBeenCalledWith({ cwds: ["/workspace"], forceReload: true });
  });

  it("读取当前目录配置中的默认模型和思考程度并保留隐藏模型元数据", async () => {
    const listModels = vi.fn(() => completed({
      data: [{
        defaultReasoningEffort: "medium",
        description: "项目配置模型",
        displayName: "Configured Model",
        hidden: true,
        id: "configured-model",
        isDefault: false,
        model: "configured-model",
        supportedReasoningEfforts: [
          { description: "深入推理", reasoningEffort: "high" },
        ],
      }],
      nextCursor: null,
    }));
    const client = {
      listApps: () => completed({ data: [], nextCursor: null }),
      listModels,
      listPermissionProfiles: () => completed({ data: [], nextCursor: null }),
      listPlugins: () => completed({ marketplaces: [] }),
      listSkills: () => completed({ data: [] }),
      readConfig: () => completed({
        config: {
          model: "configured-model",
          model_reasoning_effort: "high",
          service_tier: "priority",
        },
        origins: {},
      }),
      readConfigRequirements: () => completed({ requirements: null }),
      searchFiles: () => completed({ files: [] }),
      writeConfigValue: () => completed({
        filePath: "/config.toml",
        status: "ok",
        version: "sha256:updated",
      }),
    } satisfies CapabilityClient;

    const { result } = renderHook(() => useComposerCapabilities(client, "/workspace"));

    await waitFor(() => expect(result.current.defaultsLoading).toBe(false));
    expect(result.current.defaultModel).toBe("configured-model");
    expect(result.current.defaultEffort).toBe("high");
    expect(result.current.defaultServiceTier).toBe("priority");
    expect(result.current.models).toHaveLength(1);
    expect(listModels).toHaveBeenCalledWith({ includeHidden: true, limit: 100 });
  });

  it("分页读取应用并只保留可用应用和已启用插件引用", async () => {
    const listApps = vi.fn((params: AppsListParams = {}) => completed<AppsListResponse>(
      params.cursor === "apps-page-2"
        ? {
            data: [{ id: "hidden", isAccessible: false, name: "Hidden" }],
            nextCursor: null,
          }
        : {
            data: [{
              description: "读取日历事件",
              id: "calendar",
              isAccessible: true,
              isEnabled: true,
              name: "Calendar",
              pluginDisplayNames: ["Productivity"],
            }],
            nextCursor: "apps-page-2",
          },
    ));
    const plugins: PluginListResponse = {
      marketplaces: [{
        interface: { displayName: "Official" },
        name: "official",
        plugins: [
          {
            authPolicy: "ON_USE",
            enabled: true,
            id: "design@official",
            installPolicy: "AVAILABLE",
            installed: true,
            name: "design",
            source: { path: "/plugins/design", type: "local" },
          },
          {
            authPolicy: "ON_USE",
            enabled: false,
            id: "disabled@official",
            installPolicy: "AVAILABLE",
            installed: true,
            name: "disabled",
            source: { path: "/plugins/disabled", type: "local" },
          },
        ],
      }],
    };
    const client = {
      listApps,
      listModels: () => completed({ data: [], nextCursor: null }),
      listPermissionProfiles: () => completed({ data: [], nextCursor: null }),
      listPlugins: vi.fn(() => completed(plugins)),
      listSkills: () => completed({ data: [] }),
      readConfig: () => completed({
        config: { default_permissions: ":workspace" },
        origins: {},
      }),
      readConfigRequirements: () => completed({ requirements: null }),
      searchFiles: () => completed({ files: [] }),
      writeConfigValue: () => completed({
        filePath: "/config.toml",
        status: "ok",
        version: "sha256:updated",
      }),
    } satisfies CapabilityClient;
    const { result } = renderHook(() => useComposerCapabilities(client, "/workspace"));
    await waitFor(() => expect(result.current.modelsLoading).toBe(false));

    await act(async () => result.current.loadMentions());

    expect(result.current.mentionReferences).toEqual([
      {
        kind: "app",
        name: "Calendar",
        description: "读取日历事件",
        source: "Productivity",
        path: "app://calendar",
        searchTerms: ["calendar", "Calendar", "读取日历事件", "Productivity"],
      },
      {
        kind: "plugin",
        name: "design",
        description: "official",
        source: "Official",
        path: "plugin://design@official",
        searchTerms: ["design@official", "design", "design", "official", "official"],
      },
    ]);
    expect(listApps).toHaveBeenNthCalledWith(1, { limit: 100 });
    expect(listApps).toHaveBeenNthCalledWith(2, { cursor: "apps-page-2", limit: 100 });
    expect(client.listPlugins).toHaveBeenCalledWith({ cwds: ["/workspace"] });
    expect(result.current.defaultPermission).toBe(":workspace");
    expect(result.current.mentionsError).toBeNull();
  });

  it("仅展示服务器明确且允许的默认权限", async () => {
    const client = {
      listApps: () => completed({ data: [], nextCursor: null }),
      listModels: () => completed({ data: [], nextCursor: null }),
      listPermissionProfiles: () => completed({
        data: [{ allowed: true, id: "managed" }],
        nextCursor: null,
      }),
      listPlugins: () => completed({ marketplaces: [] }),
      listSkills: () => completed({ data: [] }),
      readConfig: () => completed({
        config: { default_permissions: ":danger-full-access" },
        origins: {},
      }),
      readConfigRequirements: () => completed({
        requirements: {
          allowedPermissionProfiles: {
            ":danger-full-access": false,
            managed: true,
          },
          defaultPermissions: "managed",
        },
      }),
      searchFiles: () => completed({ files: [] }),
      writeConfigValue: () => completed({
        filePath: "/config.toml",
        status: "ok",
        version: "sha256:updated",
      }),
    } satisfies CapabilityClient;

    const { result } = renderHook(() => useComposerCapabilities(client, "/workspace"));

    await waitFor(() => expect(result.current.permissionsLoading).toBe(false));
    expect(result.current.defaultPermission).toBe("managed");
  });
});
