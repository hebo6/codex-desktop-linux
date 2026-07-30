import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import type { CSSProperties } from "react";
import { describe, expect, it, vi } from "vitest";

import { resolveLink } from "../content/linkResolver";
import type {
  HighlightedLines,
  SyntaxHighlighter,
} from "../content/syntaxHighlighting";
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

  it("使用代码围栏语言和明暗主题 token 高亮代码", async () => {
    const highlighter: SyntaxHighlighter = {
      highlight: vi.fn(async () => [
        [
          {
            content: "const",
            style: {
              "--shiki-dark": "#ff7b72",
              "--shiki-light": "#cf222e",
            } as CSSProperties,
          },
          {
            content: " value = 1;",
            style: {
              "--shiki-dark": "#c9d1d9",
              "--shiki-light": "#24292f",
            } as CSSProperties,
          },
        ],
        [
          {
            content: "return value;",
            style: {
              "--shiki-dark": "#c9d1d9",
              "--shiki-light": "#24292f",
            } as CSSProperties,
          },
        ],
      ]),
    };
    render(
      <SafeMarkdown
        source={'```ts title="example.ts"\nconst value = 1;\nreturn value;\n```'}
        syntaxHighlighter={highlighter}
      />,
    );

    const token = await screen.findByText("const", { exact: true });
    expect(highlighter.highlight).toHaveBeenCalledWith(
      "const value = 1;\nreturn value;",
      "typescript",
    );
    expect(screen.getByText("TypeScript")).toBeVisible();
    expect(token.style.getPropertyValue("--shiki-light")).toBe("#cf222e");
    expect(token.style.getPropertyValue("--shiki-dark")).toBe("#ff7b72");
    expect(token.closest("code")).toHaveTextContent(
      "const value = 1; return value;",
    );
  });

  it("不高亮未知语言和流式输出中尚未闭合的围栏", () => {
    const highlighter: SyntaxHighlighter = {
      highlight: vi.fn(async () => []),
    };
    render(
      <SafeMarkdown
        source={"```unknown\nvalue\n```\n\n```ts\nconst streaming = true;"}
        syntaxHighlighter={highlighter}
      />,
    );

    expect(highlighter.highlight).not.toHaveBeenCalled();
    expect(screen.getByText("unknown")).toBeVisible();
    expect(screen.getByText("value")).toBeVisible();
    expect(screen.getByText("const streaming = true;")).toBeVisible();
  });

  it("忽略过期或内容不一致的异步高亮结果", async () => {
    const pending = new Map<
      string,
      (lines: HighlightedLines) => void
    >();
    const highlighter: SyntaxHighlighter = {
      highlight: vi.fn((source) => new Promise<HighlightedLines>((resolve) => {
        pending.set(source, resolve);
      })),
    };
    const { rerender } = render(
      <SafeMarkdown
        source={"```ts\nold value\n```"}
        syntaxHighlighter={highlighter}
      />,
    );
    await waitFor(() => expect(pending.has("old value")).toBe(true));

    rerender(
      <SafeMarkdown
        source={"```ts\nnew value\n```"}
        syntaxHighlighter={highlighter}
      />,
    );
    await waitFor(() => expect(pending.has("new value")).toBe(true));
    pending.get("new value")?.([[
      { content: "new value", style: {} },
    ]]);
    expect(await screen.findByText("new value", { selector: "span" }))
      .toBeVisible();

    pending.get("old value")?.([[
      { content: "stale result", style: {} },
    ]]);
    await waitFor(() =>
      expect(screen.queryByText("stale result")).not.toBeInTheDocument(),
    );

    rerender(
      <SafeMarkdown
        source={"```ts\ntrusted source\n```"}
        syntaxHighlighter={highlighter}
      />,
    );
    await waitFor(() => expect(pending.has("trusted source")).toBe(true));
    pending.get("trusted source")?.([[
      { content: "different source", style: {} },
    ]]);
    await waitFor(() =>
      expect(screen.queryByText("different source")).not.toBeInTheDocument(),
    );
    expect(screen.getByText("trusted source")).toBeVisible();
  });

  it("仅为非空 Shell 代码块提供确认后执行", async () => {
    let completeExecution: (accepted: boolean) => void = (_accepted) => {
      throw new Error("Shell 执行尚未开始");
    };
    const onRunShellCommand = vi.fn(() => new Promise<boolean>((resolve) => {
      completeExecution = resolve;
    }));
    render(
      <SafeMarkdown
        onRunShellCommand={onRunShellCommand}
        source={[
          "```bash",
          "echo first",
          "echo second",
          "```",
          "",
          "```console",
          "$ echo output",
          "```",
          "",
          "```sh",
          "```",
        ].join("\n")}
      />,
    );

    const trigger = screen.getByRole("button", { name: "执行 Shell 命令" });
    expect(screen.getAllByRole("button", { name: "执行 Shell 命令" }))
      .toHaveLength(1);
    fireEvent.click(trigger);
    const confirmation = screen.getByRole("alertdialog", {
      name: "确认执行这段 Shell 命令？",
    });
    const cancel = within(confirmation).getByRole("button", { name: "取消" });
    expect(cancel).toHaveFocus();

    fireEvent.click(within(confirmation).getByRole("button", { name: "执行" }));
    expect(onRunShellCommand).toHaveBeenCalledWith("echo first\necho second");
    expect(trigger).toBeDisabled();
    expect(trigger).toHaveTextContent("执行中");
    completeExecution(true);
    await waitFor(() => expect(trigger).toBeEnabled());
    expect(trigger).toHaveTextContent("执行");
  });

  it("支持取消 Shell 执行确认", () => {
    render(
      <SafeMarkdown
        onRunShellCommand={vi.fn(async () => true)}
        source={"```zsh\npwd\n```"}
      />,
    );
    const trigger = screen.getByRole("button", { name: "执行 Shell 命令" });

    fireEvent.click(trigger);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();

    fireEvent.click(trigger);
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });

  it("Shell 执行不可用时禁用入口并关闭确认", () => {
    const onRunShellCommand = vi.fn(async () => true);
    const { rerender } = render(
      <SafeMarkdown
        onRunShellCommand={onRunShellCommand}
        source={"```sh\npwd\n```"}
      />,
    );
    const trigger = screen.getByRole("button", { name: "执行 Shell 命令" });
    fireEvent.click(trigger);
    expect(screen.getByRole("alertdialog")).toBeVisible();

    rerender(
      <SafeMarkdown
        onRunShellCommand={onRunShellCommand}
        shellCommandDisabled
        source={"```sh\npwd\n```"}
      />,
    );
    expect(trigger).toBeDisabled();
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(onRunShellCommand).not.toHaveBeenCalled();
  });
});
