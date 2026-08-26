// @vitest-environment node

import react from "@vitejs/plugin-react";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type ViteDevServer } from "vite";

const ROOT_DIRECTORY = new URL("../", import.meta.url).pathname;
let server: ViteDevServer;

beforeAll(async () => {
  server = await createServer({
    configFile: false,
    logLevel: "silent",
    optimizeDeps: { noDiscovery: true },
    plugins: [react()],
    root: ROOT_DIRECTORY,
    server: { middlewareMode: true },
  });
});

afterAll(async () => {
  await server.close();
}, 30_000);

describe("React Refresh 边界", () => {
  it("不把有 createRoot 副作用的入口注册为热更新边界", async () => {
    const transformed = await server.transformRequest("/src/main.tsx");

    expect(transformed?.code).not.toContain(
      "validateRefreshBoundaryAndEnqueueUpdate",
    );
  });

  it("组件边界只包含组件运行时导出", async () => {
    const applicationRoot = await server.transformRequest(
      "/src/ApplicationRoot.tsx",
    );
    const app = await server.transformRequest("/src/App.tsx");
    expect(runtimeExportNames(applicationRoot?.code ?? ""))
      .toEqual(["ApplicationRoot"]);
    expect(runtimeExportNames(app?.code ?? "")).toEqual(["App"]);
    expect(applicationRoot?.code).toContain(
      "validateRefreshBoundaryAndEnqueueUpdate",
    );
  });
});

function runtimeExportNames(code: string): string[] {
  return [...code.matchAll(
    /^export\s+(?:async\s+)?(?:class|const|function|let|var)\s+([\w$]+)/gmu,
  )].map((match) => match[1]!);
}
