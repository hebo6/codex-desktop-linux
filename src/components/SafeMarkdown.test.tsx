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
    render(<SafeMarkdown source={'# 标题\n\n- [x] 完成\n- [ ] 待办\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n\n> 引用\n\n```ts\nconst x = 1\n```\n\n<script>危险</script>\n\n正文'} />);
    expect(screen.getByRole("heading", { name: "标题" })).toBeVisible();
    expect(screen.getByRole("checkbox", { name: "已完成" })).toBeChecked();
    expect(screen.getByRole("table")).toBeVisible();
    expect(screen.getByText("const x = 1")).toBeVisible();
    expect(document.querySelector("script")).toBeNull();
    expect(screen.queryByText("危险")).not.toBeInTheDocument();
    expect(screen.getByText("正文")).toBeVisible();
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

  it("按标准语法渲染嵌套列表、嵌套强调和带括号的引用链接", () => {
    const onOpenLink = vi.fn();
    const { container } = render(<SafeMarkdown onOpenLink={onOpenLink} source={[
      "3. **重点含 *斜体***",
      "   - 子项",
      "",
      "[文档][ref]",
      "",
      "[ref]: https://example.com/a_(b)",
    ].join("\n")} />);
    expect(container.querySelector("ol")).toHaveAttribute("start", "3");
    expect(container.querySelector("ol > li > ul > li")).toHaveTextContent("子项");
    expect(container.querySelector("strong em")).toHaveTextContent("斜体");
    fireEvent.click(screen.getByRole("button", { name: "文档" }));
    expect(onOpenLink).toHaveBeenCalledWith("https://example.com/a_(b)");
  });

  it.each([
    ["$2^n$", false],
    ["\\(2^n\\)", false],
    ["$$\n2^n\n$$", true],
    ["\\[\n2^n\n\\]", true],
    ["```math\n2^n\n```", true],
  ])("渲染公式 %s", (source, display) => {
    const { container } = render(<SafeMarkdown source={source} />);
    expect(container.querySelectorAll(".katex")).toHaveLength(1);
    expect(container.querySelectorAll(".katex-display")).toHaveLength(display ? 1 : 0);
    expect(container.querySelector("annotation")).toHaveTextContent("2^n");
    expect(container.querySelector(".katex-error")).toBeNull();
  });

  it("渲染截图中的下括号和中文注释，并只复制一次公式源码", () => {
    const formula = String.raw`\underbrace{2 \times 2 \times \cdots \times 2}_{n\text{ 个}} = 2^n`;
    const source = "\\[\n" + formula + "\n\\]";
    const { container } = render(<SafeMarkdown source={source} />);
    expect(container.querySelector(".katex-display .katex")).not.toBeNull();
    expect(container.querySelector(".katex-error")).toBeNull();
    expect(markdownToPlainText(source)).toBe(formula);
  });

  it("代码区域内保留公式源码，latex 代码块仍展示源码", () => {
    const { container } = render(<SafeMarkdown source={[
      "`$2^n$` 与 `\\(2^n\\)`",
      "",
      "```latex",
      "\\[2^n\\]",
      "```",
    ].join("\n")} />);
    expect(container.querySelector(".katex")).toBeNull();
    expect(container.querySelector("pre code")).toHaveTextContent("\\[2^n\\]");
    expect(screen.getByText("$2^n$")).toBeVisible();
  });

  it.each([
    ["$$\n2^n", "$$\n2^n\n$$"],
    ["\\[\n2^n", "\\[\n2^n\n\\]"],
    ["```math\n2^n", "```math\n2^n\n```"],
  ])("流式公式闭合前保留源码：%s", (partial, complete) => {
    const { container, rerender } = render(<SafeMarkdown source={partial} />);
    expect(container.querySelector(".katex")).toBeNull();
    expect(container).toHaveTextContent("2^n");
    rerender(<SafeMarkdown source={complete} />);
    expect(container.querySelector(".katex")).not.toBeNull();
    expect(container.querySelector(".katex-error")).toBeNull();
  });

  it("不执行公式中的链接或 HTML 命令，错误公式不影响后续正文", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { container } = render(<SafeMarkdown source={[
      String.raw`$\href{javascript:alert(1)}{x}$`,
      "",
      String.raw`$\htmlClass{attack}{x}$`,
      "",
      String.raw`$\frac{1}$`,
      "",
      "后续正文",
    ].join("\n")} />);
    expect(container.querySelector("a, .attack, script")).toBeNull();
    expect(container.querySelector(".katex-error")).not.toBeNull();
    expect(screen.getByText("后续正文")).toBeVisible();
  });

  it("链接和图片不产生浏览器导航或资源加载，文件定位仍交给统一解析器", () => {
    const onOpenLink = vi.fn();
    const { container } = render(<SafeMarkdown onOpenLink={onOpenLink} source={[
      "[相对](App.tsx:42)",
      "[绝对](file:///workspace/App.tsx#L42)",
      "[危险](javascript:alert%281%29)",
      "![外部](https://example.com/image.png)",
    ].join(" ")} />);
    expect(container.querySelector("a, img, [href], [src]")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "相对" }));
    fireEvent.click(screen.getByRole("button", { name: "绝对" }));
    fireEvent.click(screen.getByRole("button", { name: "危险" }));
    expect(onOpenLink).toHaveBeenNthCalledWith(1, "App.tsx:42");
    expect(onOpenLink).toHaveBeenNthCalledWith(2, "file:///workspace/App.tsx#L42");
    expect(resolveLink(onOpenLink.mock.calls[2]?.[0], "/workspace").type).toBe("blocked");
  });

  it("紧凑摘要保留行内格式与数学排版，不产生块级元素或交互入口", () => {
    const { container } = render(<SafeMarkdown onOpenLink={vi.fn()} variant="compact" source={[
      "# **摘要**",
      "",
      "- [x] [来源](https://example.com)",
      "- 第二项",
      "",
      "\\[",
      "2^n",
      "\\]",
      "",
      "```ts",
      "const n = 2;",
      "```",
    ].join("\n")} />);
    expect(container.firstElementChild?.tagName).toBe("SPAN");
    expect(container.querySelector("p, div, pre, ul, li, h1, button, input, .katex-display")).toBeNull();
    expect(container.querySelector("strong")).toHaveTextContent("摘要");
    expect(container.querySelector(".katex")).not.toBeNull();
    expect(container).toHaveTextContent("• ☑ 来源 · • 第二项");
  });

  it("math 围栏在紧凑摘要中也按公式排版", () => {
    const { container } = render(<SafeMarkdown variant="compact" source={"```math\n2^n\n```"} />);
    expect(container.querySelector(".katex")).not.toBeNull();
    expect(container.querySelector(".katex-display, pre")).toBeNull();
  });

  it("链接内的图片只由外层链接处理点击", () => {
    const onOpenLink = vi.fn();
    const { container } = render(<SafeMarkdown onOpenLink={onOpenLink} source="[![图](image.png)](https://example.com)" />);
    expect(container.querySelector("button button")).toBeNull();
    fireEvent.click(screen.getByText("图片：图"));
    expect(onOpenLink).toHaveBeenCalledExactlyOnceWith("https://example.com");
  });

  it("流式更新保持代码块组件和折行状态，较长围栏闭合后才高亮", async () => {
    const highlighter: SyntaxHighlighter = { highlight: vi.fn(async () => []) };
    const { container, rerender } = render(<SafeMarkdown syntaxHighlighter={highlighter} source={"````ts\nfirst\n```"} />);
    const pre = container.querySelector("pre");
    fireEvent.click(screen.getByRole("button", { name: "折行" }));
    expect(highlighter.highlight).not.toHaveBeenCalled();
    rerender(<SafeMarkdown syntaxHighlighter={highlighter} source={"````ts\nfirst\n```\nsecond\n````"} />);
    expect(container.querySelector("pre")).toBe(pre);
    expect(pre).toHaveAttribute("data-wrapped", "true");
    await waitFor(() => expect(highlighter.highlight).toHaveBeenCalledWith("first\n```\nsecond", "typescript"));
  });

  it("引用和列表中的波浪线代码围栏沿用标准闭合规则", async () => {
    const highlighter: SyntaxHighlighter = { highlight: vi.fn(async () => []) };
    render(<SafeMarkdown syntaxHighlighter={highlighter} source={"> - ~~~ts\n>   const n = 2;\n>   ~~~"} />);
    await waitFor(() => expect(highlighter.highlight).toHaveBeenCalledWith("const n = 2;", "typescript"));
  });

  it("标题与脚注生成可定位的锚点", () => {
    const onOpenLink = vi.fn();
    const { container } = render(<SafeMarkdown onOpenLink={onOpenLink} source={"# 标题\n\n[跳转](#标题) 和脚注[^note]\n\n[^note]: 注释内容"} />);
    expect(screen.getByRole("heading", { name: "标题" })).toHaveAttribute("id", "标题");
    fireEvent.click(screen.getByRole("button", { name: "1" }));
    const target = onOpenLink.mock.calls[0]?.[0] as string;
    expect(target.startsWith("#")).toBe(true);
    expect(container.querySelector(`[id="${target.slice(1)}"]`)).not.toBeNull();
  });
});
