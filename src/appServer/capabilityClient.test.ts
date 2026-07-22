import { describe, expect, it } from "vitest";

import type { RequestHandle, SendRequestOptions } from "../protocol/rpc";
import { AppServerCapabilityClient } from "./capabilityClient";

class RecordingSession {
  readonly requests: SendRequestOptions<unknown>[] = [];

  sendRequest<T>(options: SendRequestOptions<T>): RequestHandle<T> {
    this.requests.push(options as SendRequestOptions<unknown>);
    return {
      epoch: 1,
      id: `request-${this.requests.length}`,
      stage: "pending",
      result: new Promise<T>(() => undefined),
    };
  }
}

describe("AppServerCapabilityClient", () => {
  it("映射模型、技能、文件、权限、配置、应用和插件请求", () => {
    const session = new RecordingSession();
    const client = new AppServerCapabilityClient(session);

    client.listModels({ limit: 100 });
    client.listSkills({ cwds: ["/workspace"] });
    client.searchFiles({ query: "readme", roots: ["/workspace"], cancellationToken: "search-1" });
    client.listPermissionProfiles({ cwd: "/workspace" });
    client.readConfig({ cwd: "/workspace", includeLayers: false });
    client.readConfigRequirements();
    client.listApps({ limit: 100 });
    client.listPlugins({ cwds: ["/workspace"] });

    expect(session.requests.map(({ method, params }) => ({ method, params }))).toEqual([
      { method: "model/list", params: { limit: 100 } },
      { method: "skills/list", params: { cwds: ["/workspace"] } },
      {
        method: "fuzzyFileSearch",
        params: { query: "readme", roots: ["/workspace"], cancellationToken: "search-1" },
      },
      { method: "permissionProfile/list", params: { cwd: "/workspace" } },
      { method: "config/read", params: { cwd: "/workspace", includeLayers: false } },
      { method: "configRequirements/read", params: undefined },
      { method: "app/list", params: { limit: 100 } },
      { method: "plugin/list", params: { cwds: ["/workspace"] } },
    ]);
    for (const request of session.requests) {
      expect(request.validateResult(null).ok).toBe(false);
    }
  });
});
