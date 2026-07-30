import { renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { CapabilityClient } from "../appServer";
import type { RequestHandle } from "../protocol/rpc";
import {
  configuredProjectDirectories,
  useConfiguredProjects,
} from "./useConfiguredProjects";

function completed<T>(value: T): RequestHandle<T> {
  return {
    epoch: 1,
    id: crypto.randomUUID(),
    stage: "pending",
    result: Promise.resolve(value),
  };
}

function capabilityClient(
  readConfig: CapabilityClient["readConfig"],
  writeConfigValue: CapabilityClient["writeConfigValue"] = () => completed({
    filePath: "/config.toml",
    overriddenMetadata: null,
    status: "ok",
    version: "sha256:updated",
  }),
): CapabilityClient {
  return {
    listApps: () => completed({ data: [], nextCursor: null }),
    listModels: () => completed({ data: [], nextCursor: null }),
    listPermissionProfiles: () => completed({ data: [], nextCursor: null }),
    listPlugins: () => completed({ marketplaces: [] }),
    listSkills: () => completed({ data: [] }),
    readConfig,
    readConfigRequirements: () => completed({ requirements: null }),
    searchFiles: () => completed({ files: [] }),
    writeConfigValue,
  };
}

describe("useConfiguredProjects", () => {
  it("从线程无关配置读取并稳定排序项目目录", async () => {
    const readConfig = vi.fn(() => completed({
      config: {
        projects: {
          "/workspace/zeta": { trust_level: "untrusted" },
          "/workspace/alpha": { trust_level: "trusted" },
        },
      },
      origins: {},
    }));
    const client = capabilityClient(readConfig);

    const { result } = renderHook(() =>
      useConfiguredProjects(client),
    );

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(readConfig).toHaveBeenCalledWith({ includeLayers: false });
    expect(result.current.directories).toEqual([
      "/workspace/alpha",
      "/workspace/zeta",
    ]);
    expect(result.current.error).toBeNull();
  });

  it("拒绝非对象形式的 projects", () => {
    expect(() => configuredProjectDirectories({
      projects: ["/workspace/project"],
    })).toThrow("config.projects must be an object");
  });

  it("删除项目配置并立即从列表移除", async () => {
    const writeConfigValue = vi.fn(() => completed({
      filePath: "/config.toml",
      overriddenMetadata: null,
      status: "ok" as const,
      version: "sha256:updated",
    }));
    const client = capabilityClient(
      () => completed({
        config: {
          projects: {
            "/workspace/team.alpha": { trust_level: "trusted" },
            "/workspace/other": { trust_level: "trusted" },
          },
        },
        origins: {},
      }),
      writeConfigValue,
    );
    const { result } = renderHook(() => useConfiguredProjects(client));
    await waitFor(() => expect(result.current.loading).toBe(false));

    await result.current.remove("/workspace/team.alpha");

    expect(writeConfigValue).toHaveBeenCalledWith({
      keyPath: "projects.\"/workspace/team.alpha\"",
      mergeStrategy: "replace",
      value: null,
    });
    await waitFor(() =>
      expect(result.current.directories).toEqual(["/workspace/other"])
    );
  });

  it("配置读取失败时不提供项目目录", async () => {
    const readConfig = vi.fn(() => ({
      epoch: 1,
      id: "config-read",
      stage: "pending" as const,
      result: Promise.reject(new Error("offline")),
    }));
    const client = capabilityClient(readConfig);

    const { result } = renderHook(() =>
      useConfiguredProjects(client),
    );

    await waitFor(() =>
      expect(result.current.error).toBe("无法读取服务器项目配置"),
    );
    expect(result.current.directories).toEqual([]);
  });
});
