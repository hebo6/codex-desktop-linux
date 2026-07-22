import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { resolveLink } from "../content/linkResolver";
import { markdownToPlainText, SafeMarkdown } from "./SafeMarkdown";

describe("SafeMarkdown", () => {
  it("渲染 GFM 常用块并忽略原始 HTML", () => {
    render(<SafeMarkdown source={'# 标题\n\n- [x] 完成\n- [ ] 待办\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n\n> 引用\n\n```ts\nconst x = 1\n```\n\n<script>危险</script>正文'} />);
    expect(screen.getByRole("heading", { name: "标题" })).toBeVisible();
    expect(screen.getByRole("checkbox", { name: "已完成" })).toBeChecked();
    expect(screen.getByRole("table")).toBeVisible();
    expect(screen.getByText("const x = 1")).toBeVisible();
    expect(document.querySelector("script")).toBeNull();
    expect(screen.getByText("危险正文")).toBeVisible();
  });

  it("所有链接统一交给调用者处理", () => {
    const onOpenLink = vi.fn();
    render(<SafeMarkdown onOpenLink={onOpenLink} source="[网页](https://example.com) ![图片](./a.png)" />);
    fireEvent.click(screen.getByRole("button", { name: "网页" }));
    fireEvent.click(screen.getByRole("button", { name: "图片：图片" }));
    expect(onOpenLink).toHaveBeenNthCalledWith(1, "https://example.com");
    expect(onOpenLink).toHaveBeenNthCalledWith(2, "./a.png");
  });

  it("未提供链接处理器时只展示静态链接", () => {
    render(<SafeMarkdown source="[网页](https://example.com)" />);
    expect(screen.getByText("网页")).toBeVisible();
    expect(screen.queryByRole("button", { name: "网页" })).not.toBeInTheDocument();
  });

  it("从同一 Markdown 结构生成渲染后的纯文本", () => {
    expect(markdownToPlainText("# 标题\n\n- [x] **完成**\n\n| 文件 | 状态 |\n| --- | --- |\n| foo-bar.ts | [通过](https://example.com) |"))
      .toBe("标题\n• ☑ 完成\n文件\t状态\nfoo-bar.ts\t通过");
  });

  it("将尖括号包裹的带空格文件链接交给统一解析器", () => {
    let resolved: ReturnType<typeof resolveLink> | null = null;
    render(
      <SafeMarkdown
        onOpenLink={(link) => {
          resolved = resolveLink(link, "/workspace");
        }}
        source="[源码](<My Project/App.tsx:42>)"
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "源码" }));
    expect(resolved).toEqual({
      type: "file",
      path: "/workspace/My Project/App.tsx",
      line: 42,
      endLine: null,
      column: null,
    });
  });
});
