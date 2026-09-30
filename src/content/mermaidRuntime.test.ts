// @vitest-environment node
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

import tauriConfiguration from "../../src-tauri/tauri.conf.json";

describe("Mermaid 实际运行时初始化", () => {
  it("真实依赖能在 Tauri 的原型设置下加载", () => {
    // 独立进程避免 Vitest 的模块缓存和 mock 隐藏依赖初始化失败
    const output = execFileSync(process.execPath, ["--input-type=module", "--eval", `
      import assert from "node:assert/strict";
      if (${tauriConfiguration.app.security.freezePrototype}) Object.freeze(Object.prototype);
      try {
        const { default: mermaid } = await import("mermaid");
        assert.equal(typeof mermaid.initialize, "function");
        assert.equal(typeof mermaid.render, "function");
        mermaid.initialize({ startOnLoad: false, securityLevel: "strict" });
        process.stdout.write("initialized");
      } catch (error) {
        process.stderr.write(error.message);
        process.exitCode = 1;
      }
    `], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    expect(output).toBe("initialized");
  });
});
