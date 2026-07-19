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
      endLine: null,
      column: 7,
    });
    expect(resolveLink("README.md", null)).toMatchObject({ type: "blocked" });
    expect(resolveLink("file:///remote/image.png", null)).toEqual({
      type: "file",
      path: "/remote/image.png",
      line: null,
      endLine: null,
      column: null,
    });
  });

  it("解析 AI 回答使用的冒号行列和行范围", () => {
    expect(resolveLink("/workspace/src/App.tsx:42", "/workspace")).toEqual({
      type: "file",
      path: "/workspace/src/App.tsx",
      line: 42,
      endLine: null,
      column: null,
    });
    expect(resolveLink("src/App.tsx:42:7", "/workspace")).toEqual({
      type: "file",
      path: "/workspace/src/App.tsx",
      line: 42,
      endLine: null,
      column: 7,
    });
    expect(resolveLink("App.tsx:42", "/workspace")).toEqual({
      type: "file",
      path: "/workspace/App.tsx",
      line: 42,
      endLine: null,
      column: null,
    });
    expect(resolveLink("/workspace/src/App.tsx:42-45", "/workspace")).toEqual({
      type: "file",
      path: "/workspace/src/App.tsx",
      line: 42,
      endLine: 45,
      column: null,
    });
    expect(resolveLink("/workspace/src/App.tsx#L42-L45", "/workspace")).toEqual({
      type: "file",
      path: "/workspace/src/App.tsx",
      line: 42,
      endLine: 45,
      column: null,
    });
  });

  it("区分 Windows 盘符、文件位置和危险协议", () => {
    expect(resolveLink("C:\\workspace\\App.tsx:42:7", null)).toEqual({
      type: "file",
      path: "C:\\workspace\\App.tsx",
      line: 42,
      endLine: null,
      column: 7,
    });
    expect(resolveLink("file:///workspace/App.tsx:42", null)).toEqual({
      type: "file",
      path: "/workspace/App.tsx",
      line: 42,
      endLine: null,
      column: null,
    });
    expect(resolveLink("javascript:alert(1)", "/workspace")).toMatchObject({ type: "blocked" });
  });

  it("拒绝无效行列和倒序范围", () => {
    expect(resolveLink("/workspace/App.tsx:0", "/workspace")).toMatchObject({
      type: "blocked",
      reason: "文件定位行列无效",
    });
    expect(resolveLink("/workspace/App.tsx:45-42", "/workspace")).toMatchObject({
      type: "blocked",
      reason: "文件定位行列无效",
    });
    expect(resolveLink("/workspace/App.tsx#L9007199254740992", "/workspace")).toMatchObject({
      type: "blocked",
      reason: "文件定位行列无效",
    });
  });
});
