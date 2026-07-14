import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { CapabilityClient } from "../appServer";
import type {
  AppsListParams,
  AppsListResponse,
  PluginListResponse,
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
      searchFiles: () => completed({ files: [] }),
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
    expect(result.current.mentionsError).toBeNull();
  });
});
