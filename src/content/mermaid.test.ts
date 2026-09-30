import { waitFor } from "@testing-library/react";
import mermaid, { type MermaidConfig, type RenderResult } from "mermaid";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { renderMermaid } from "./mermaid";

vi.mock("mermaid", async (importOriginal) => {
  const actual = await importOriginal<typeof import("mermaid")>();
  return { ...actual, default: { ...actual.default, render: vi.fn() } };
});

const rendered: RenderResult = { svg: "<svg></svg>", diagramType: "flowchart-v2" };
const renderMock = vi.mocked(mermaid.render);

describe("Mermaid 渲染服务", () => {
  beforeEach(() => {
    renderMock.mockReset();
    renderMock.mockResolvedValue(rendered);
  });

  it("初始化与渲染串行执行，临时容器在完成后移除", async () => {
    let finish!: (result: RenderResult) => void;
    renderMock.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
    const first = renderMermaid("flowchart LR; A-->B", "light");
    await waitFor(() => expect(renderMock).toHaveBeenCalledTimes(1));
    const firstContainer = renderMock.mock.calls[0]?.[2];
    expect(firstContainer?.isConnected).toBe(true);

    const second = renderMermaid("flowchart LR; B-->C", "dark");
    expect(mermaid.mermaidAPI.getSiteConfig().theme).toBe("default");
    expect(renderMock).toHaveBeenCalledTimes(1);
    finish(rendered);
    await expect(first).resolves.toBe(rendered.svg);
    await expect(second).resolves.toBe(rendered.svg);
    expect(mermaid.mermaidAPI.getSiteConfig().theme).toBe("dark");
    expect(firstContainer?.isConnected).toBe(false);
    expect(renderMock.mock.calls[1]?.[2]?.isConnected).toBe(false);
    expect(renderMock.mock.calls[0]?.[0]).not.toBe(renderMock.mock.calls[1]?.[0]);
  });

  it("失败仍清理临时 DOM，后续图表可以继续生成", async () => {
    renderMock.mockRejectedValueOnce(new Error("语法错误"));
    await expect(renderMermaid("invalid", "light")).rejects.toThrow("语法错误");
    expect(renderMock.mock.calls[0]?.[2]?.isConnected).toBe(false);
    await expect(renderMermaid("flowchart LR; A-->B", "light")).resolves.toBe(rendered.svg);
  });

  it("通过真实解析器验证 frontmatter 不能覆盖应用的安全与主题配置", async () => {
    let parsedConfig: MermaidConfig | undefined;
    renderMock.mockImplementation(async (_id, source) => {
      await mermaid.parse(source);
      parsedConfig = mermaid.mermaidAPI.getConfig();
      return rendered;
    });
    await renderMermaid(`---
config:
  securityLevel: loose
  htmlLabels: true
  theme: forest
  themeCSS: 'body { display: none; }'
  maxTextSize: 999999
  maxEdges: 999999
  suppressErrorRendering: false
  dompurifyConfig:
    ADD_TAGS: [script]
---
flowchart LR
  A --> B`, "dark");
    expect(parsedConfig).toMatchObject({
      securityLevel: "strict", htmlLabels: false, theme: "dark", themeCSS: "",
      maxTextSize: 50_000, maxEdges: 500, suppressErrorRendering: true,
      dompurifyConfig: { FORBID_TAGS: ["style"], FORBID_ATTR: ["style"] },
    });
    expect(parsedConfig?.dompurifyConfig).not.toHaveProperty("ADD_TAGS");
  });

  it("空源码和超限源码明确报错，不替换成 Mermaid 的默认错误图", async () => {
    await expect(renderMermaid("  ", "light")).rejects.toThrow("源码为空");
    await expect(renderMermaid("x".repeat(50_001), "light")).rejects.toThrow("50,000");
    expect(renderMock).not.toHaveBeenCalled();
  });
});
