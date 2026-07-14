import { describe, expect, it } from "vitest";

import { resolveLink } from "./linkResolver";

describe("resolveLink", () => {
  it("规范化网页链接并拒绝危险协议和认证信息", () => {
    expect(resolveLink("https://Example.com/a b", "/workspace")).toMatchObject({
      type: "external",
      domain: "example.com",
      url: "https://example.com/a%20b",
    });
    expect(resolveLink("javascript:alert(1)", "/workspace")).toMatchObject({ type: "blocked" });
    expect(resolveLink("https://token@example.com", "/workspace")).toMatchObject({ type: "blocked" });
  });

  it("只在服务器工作目录上下文中解析远程相对路径", () => {
    expect(resolveLink("../src/App.tsx#L42C7", "/workspace/docs")).toEqual({
      type: "file",
      path: "/workspace/src/App.tsx",
      line: 42,
      column: 7,
    });
    expect(resolveLink("README.md", null)).toMatchObject({ type: "blocked" });
    expect(resolveLink("file:///remote/image.png", null)).toEqual({
      type: "file",
      path: "/remote/image.png",
      line: null,
      column: null,
    });
  });
});
