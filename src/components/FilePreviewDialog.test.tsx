import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { FileClient } from "../appServer";
import type { ContentProcessor } from "../content/contentProcessing";
import type { SyntaxHighlighter } from "../content/syntaxHighlighting";
import type { RequestHandle } from "../protocol/rpc";
import { FilePreviewDialog } from "./FilePreviewDialog";

function handle<T>(value: T): RequestHandle<T> {
  return { epoch: 1, id: 1, stage: "pending", result: Promise.resolve(value) };
}

function clientFor(text: string): FileClient {
  return {
    getMetadata: vi.fn(() => handle({
      createdAtMs: 1,
      isDirectory: false,
      isFile: true,
      isSymlink: false,
      modifiedAtMs: 1_700_000_000_000,
    })),
    readFile: vi.fn(() => handle({
      dataBase64: base64For(text),
    })),
  };
}

function base64For(text: string): string {
  return btoa(String.fromCharCode(...new TextEncoder().encode(text)));
}

describe("FilePreviewDialog", () => {
  it("从服务器读取文本并定位链接行列", async () => {
    const client = clientFor("first\nsecond query\nthird");
    render(
      <FilePreviewDialog
        client={client}
        onClose={vi.fn()}
        request={{ path: "/remote/src/App.tsx", line: 2, column: 3 }}
        serverName="远程开发机"
        workspacePath="/remote"
      />,
    );
    await waitFor(() => expect(screen.getByText("second query", { exact: false })).toBeVisible());
    expect(client.getMetadata).toHaveBeenCalledWith("/remote/src/App.tsx");
    expect(client.readFile).toHaveBeenCalledWith("/remote/src/App.tsx");
    expect(document.getElementById("preview-line-2")).toHaveAttribute("data-highlighted", "true");
    expect(screen.getByText(/列 3/u)).toBeVisible();
    expect(screen.getByText("UTF-8")).toBeVisible();
    expect(screen.getByText("TypeScript JSX")).toBeVisible();
    expect(screen.getByText(/src\/App\.tsx/u)).toBeVisible();
    fireEvent.change(screen.getByRole("spinbutton", { name: "跳转到行" }), {
      target: { value: "3" },
    });
    fireEvent.click(screen.getByRole("button", { name: "跳转" }));
    expect(document.getElementById("preview-line-3")).toHaveAttribute("data-highlighted", "true");
  });

  it("高亮链接携带的行范围并在手动跳转后恢复单行", async () => {
    render(
      <FilePreviewDialog
        client={clientFor("first\nsecond\nthird\nfourth")}
        onClose={vi.fn()}
        request={{ path: "/remote/src/App.tsx", line: 2, endLine: 3 }}
        serverName="远程开发机"
      />,
    );
    await waitFor(() => expect(screen.getByText("second", { exact: true })).toBeVisible());
    expect(document.getElementById("preview-line-1")).toHaveAttribute("data-highlighted", "false");
    expect(document.getElementById("preview-line-2")).toHaveAttribute("data-highlighted", "true");
    expect(document.getElementById("preview-line-3")).toHaveAttribute("data-highlighted", "true");
    expect(document.getElementById("preview-line-4")).toHaveAttribute("data-highlighted", "false");

    fireEvent.change(screen.getByRole("spinbutton", { name: "跳转到行" }), {
      target: { value: "4" },
    });
    fireEvent.click(screen.getByRole("button", { name: "跳转" }));
    expect(document.getElementById("preview-line-2")).toHaveAttribute("data-highlighted", "false");
    expect(document.getElementById("preview-line-3")).toHaveAttribute("data-highlighted", "false");
    expect(document.getElementById("preview-line-4")).toHaveAttribute("data-highlighted", "true");
  });

  it("Markdown 预览不执行原始 HTML", async () => {
    render(
      <FilePreviewDialog
        client={clientFor("# 文档\n\n<script>bad()</script>内容")}
        onClose={vi.fn()}
        request={{ path: "/remote/README.md" }}
        serverName="服务器"
      />,
    );
    await waitFor(() => expect(screen.getByRole("heading", { name: "文档" })).toBeVisible());
    expect(document.querySelector("script")).toBeNull();
    expect(screen.getByText("bad()内容")).toBeVisible();
    expect(screen.getByRole("button", { name: "预览" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    fireEvent.click(screen.getByRole("button", { name: "源码" }));
    expect(screen.getByText("<script>bad()</script>内容")).toBeVisible();
    expect(screen.getByRole("searchbox", { name: "在文件中查找" })).toBeVisible();
  });

  it("在内容 Worker 中格式化 JSON 并执行全文搜索", async () => {
    const processor: ContentProcessor = {
      formatJson: vi.fn(async () => ({
        formatted: true,
        text: '{\n  "query": "matched"\n}',
      })),
      findMatchingLines: vi.fn(async () => Uint32Array.from([1])),
    };
    render(
      <FilePreviewDialog
        client={clientFor('{"query":"matched"}')}
        contentProcessor={processor}
        onClose={vi.fn()}
        request={{ path: "/remote/data.json" }}
        serverName="服务器"
      />,
    );
    await waitFor(() =>
      expect(screen.getByText('"query": "matched"', { exact: false })).toBeVisible(),
    );
    expect(
      screen.queryByRole("searchbox", { name: "在文件中查找" }),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "源码" }));
    expect(screen.getByText('{"query":"matched"}')).toBeVisible();
    fireEvent.change(screen.getByRole("searchbox", { name: "在文件中查找" }), {
      target: { value: "matched" },
    });
    await waitFor(() =>
      expect(processor.findMatchingLines).toHaveBeenCalledWith(
        '{"query":"matched"}',
        "matched",
      ),
    );
    await waitFor(() => expect(screen.getByText("1 行匹配")).toBeVisible());
    expect(screen.getByText("matched").closest("mark")).not.toBeNull();
  });

  it("HTML 仅显示原始源码并可以交给系统浏览器打开", async () => {
    const source =
      '<h1>预览</h1><img src="asset.png"><script>alert(1)</script>';
    const client = clientFor(source);
    const htmlBrowserOpener = vi.fn(async () => {});
    render(
      <FilePreviewDialog
        client={client}
        htmlBrowserOpener={htmlBrowserOpener}
        onClose={vi.fn()}
        request={{ path: "/remote/index.html" }}
        serverName="服务器"
        workspacePath="/remote"
      />,
    );

    await waitFor(() =>
      expect(document.getElementById("preview-line-1")).toHaveTextContent(source),
    );
    expect(screen.queryByRole("button", { name: "预览" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "源码" })).not.toBeInTheDocument();
    expect(client.getMetadata).toHaveBeenCalledTimes(1);
    expect(client.readFile).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "在浏览器中打开" }));
    await waitFor(() =>
      expect(htmlBrowserOpener).toHaveBeenCalledWith(base64For(source)),
    );
    expect(screen.getByText("已在系统浏览器中打开")).toBeVisible();
  });

  it("带源码位置的 HTML 在源码视图中定位", async () => {
    render(
      <FilePreviewDialog
        client={clientFor("<h1>first</h1>\n<p>second</p>")}
        onClose={vi.fn()}
        request={{ path: "/remote/index.html", line: 2 }}
        serverName="服务器"
      />,
    );

    await waitFor(() =>
      expect(document.getElementById("preview-line-2")).toHaveAttribute(
        "data-highlighted",
        "true",
      ),
    );
    expect(screen.queryByRole("button", { name: "预览" })).not.toBeInTheDocument();
    expect(screen.getByRole("searchbox", { name: "在文件中查找" })).toBeVisible();
  });

  it("打开新文件时重新使用该文件的默认视图", async () => {
    const firstRequest = { path: "/remote/first.md" };
    const { rerender } = render(
      <FilePreviewDialog
        client={clientFor("# 第一份")}
        onClose={vi.fn()}
        request={firstRequest}
        serverName="服务器"
      />,
    );
    await screen.findByRole("heading", { name: "第一份" });
    fireEvent.click(screen.getByRole("button", { name: "源码" }));
    expect(screen.getByRole("button", { name: "源码" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    rerender(
      <FilePreviewDialog
        client={clientFor("# 第二份")}
        onClose={vi.fn()}
        request={{ path: "/remote/second.md" }}
        serverName="服务器"
      />,
    );

    await screen.findByRole("heading", { name: "第二份" });
    expect(screen.getByRole("button", { name: "预览" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(
      screen.queryByRole("searchbox", { name: "在文件中查找" }),
    ).not.toBeInTheDocument();
  });

  it("SVG 默认安全预览并在源码定位时延迟创建图片 URL", async () => {
    const create = vi.fn(() => "blob:svg-preview");
    render(
      <FilePreviewDialog
        blobUrlFactory={{ create, revoke: vi.fn() }}
        client={clientFor(
          '<svg xmlns="http://www.w3.org/2000/svg"><script>bad()</script><path d="M0 0"/></svg>',
        )}
        onClose={vi.fn()}
        request={{ path: "/remote/icon.svg", line: 1 }}
        serverName="服务器"
      />,
    );

    await waitFor(() =>
      expect(document.getElementById("preview-line-1")).toBeVisible(),
    );
    expect(screen.getByText("SVG")).toBeVisible();
    expect(create).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "预览" }));
    await waitFor(() =>
      expect(screen.getByRole("img", { name: "icon.svg" })).toHaveAttribute(
        "src",
        "blob:svg-preview",
      ),
    );
    expect(create).toHaveBeenCalledOnce();
  });

  it("使用语法 Worker 的浅色和深色 token 渲染源码", async () => {
    const highlighter: SyntaxHighlighter = {
      highlight: vi.fn(async () => [[
        {
          content: "const",
          style: {
            "--shiki-dark": "#ff7b72",
            "--shiki-light": "#cf222e",
          } as React.CSSProperties,
        },
        {
          content: " value = 1;",
          style: {
            "--shiki-dark": "#c9d1d9",
            "--shiki-light": "#24292f",
          } as React.CSSProperties,
        },
      ]]),
    };
    render(
      <FilePreviewDialog
        client={clientFor("const value = 1;")}
        onClose={vi.fn()}
        request={{ path: "/remote/source.ts" }}
        serverName="服务器"
        syntaxHighlighter={highlighter}
      />,
    );
    const token = await screen.findByText("const", { exact: true });
    expect(highlighter.highlight).toHaveBeenCalledWith(
      "const value = 1;",
      "typescript",
    );
    expect(token.style.getPropertyValue("--shiki-light")).toBe("#cf222e");
    expect(token.style.getPropertyValue("--shiki-dark")).toBe("#ff7b72");
  });

  it("图片预览使用 Blob URL 并在关闭时立即释放", async () => {
    const create = vi.fn(() => "blob:controlled-preview");
    const revoke = vi.fn();
    const { rerender } = render(
      <FilePreviewDialog
        blobUrlFactory={{ create, revoke }}
        client={clientFor("image-bytes")}
        onClose={vi.fn()}
        request={{ path: "/remote/image.png" }}
        serverName="服务器"
      />,
    );
    await waitFor(() =>
      expect(screen.getByRole("img", { name: "image.png" })).toHaveAttribute(
        "src",
        "blob:controlled-preview",
      ),
    );
    expect(create).toHaveBeenCalledWith(expect.any(Blob));

    rerender(
      <FilePreviewDialog
        blobUrlFactory={{ create, revoke }}
        client={clientFor("image-bytes")}
        onClose={vi.fn()}
        request={null}
        serverName="服务器"
      />,
    );
    expect(revoke).toHaveBeenCalledWith("blob:controlled-preview");
  });

  it("复用文件预览窗口显示用户消息中的 Data URL 图片", async () => {
    const create = vi.fn(() => "blob:user-message-image");
    render(
      <FilePreviewDialog
        blobUrlFactory={{ create, revoke: vi.fn() }}
        client={null}
        onClose={vi.fn()}
        request={{
          dataUrl: "data:image/png;base64,aW1hZ2UtYnl0ZXM=",
          name: "粘贴图片.png",
          type: "dataImage",
        }}
        serverName="服务器"
      />,
    );

    await waitFor(() =>
      expect(screen.getByRole("img", { name: "粘贴图片.png" })).toHaveAttribute(
        "src",
        "blob:user-message-image",
      ),
    );
    expect(screen.getByText("用户消息中的图片")).toBeVisible();
    expect(screen.queryByRole("button", { name: "复制路径" })).not.toBeInTheDocument();
    expect(create).toHaveBeenCalledWith(expect.any(Blob));
  });

  it("图片支持原始尺寸和以指针位置为中心缩放", async () => {
    render(
      <FilePreviewDialog
        blobUrlFactory={{ create: () => "blob:image", revoke: vi.fn() }}
        client={clientFor("image-bytes")}
        onClose={vi.fn()}
        request={{ path: "/remote/image.png" }}
        serverName="服务器"
      />,
    );
    const image = await screen.findByRole("img", { name: "image.png" });
    const viewport = image.parentElement as HTMLDivElement;
    Object.defineProperties(image, {
      naturalWidth: { configurable: true, value: 1600 },
      naturalHeight: { configurable: true, value: 1200 },
    });
    Object.defineProperties(viewport, {
      clientWidth: { configurable: true, value: 400 },
      clientHeight: { configurable: true, value: 300 },
    });
    fireEvent.load(image);
    fireEvent.click(screen.getByRole("button", { name: "原始尺寸" }));
    await waitFor(() => expect(viewport).toHaveAttribute("data-pannable", "true"));
    fireEvent.wheel(viewport, { ctrlKey: true, deltaY: -1, clientX: 300, clientY: 150 });
    await waitFor(() => expect(image.style.transform).toContain("scale(1.2)"));
    expect(image.style.transform).not.toContain("translate(0px, 0px)");
  });

  it("文件变更支持统一差异和左右对照", async () => {
    render(
      <FilePreviewDialog
        client={clientFor("new")}
        onClose={vi.fn()}
        request={{ path: "/remote/a.txt", diff: "@@ -1 +1 @@\n-old\n+new" }}
        serverName="服务器"
      />,
    );
    expect(screen.getByText("-old")).toHaveAttribute("data-kind", "remove");
    fireEvent.click(screen.getByRole("button", { name: "左右对照" }));
    expect(screen.getByRole("table", { name: "左右差异对照" })).toBeVisible();
    expect(screen.getAllByRole("cell").some((cell) => cell.textContent === "old")).toBe(true);
    expect(screen.getAllByRole("cell").some((cell) => cell.textContent === "new")).toBe(true);
  });

  it("将键盘焦点限制在文件预览对话框", async () => {
    render(
      <FilePreviewDialog
        client={clientFor("content")}
        onClose={vi.fn()}
        request={{ path: "/remote/a.txt" }}
        serverName="服务器"
      />,
    );
    await waitFor(() => expect(screen.getByRole("button", { name: "另存为" })).toBeEnabled());
    const save = screen.getByRole("button", { name: "另存为" });
    const copyPath = screen.getByRole("button", { name: "复制路径" });
    copyPath.focus();
    fireEvent.keyDown(document, { key: "Tab" });
    expect(save).toHaveFocus();
    fireEvent.keyDown(document, { key: "Tab", shiftKey: true });
    expect(copyPath).toHaveFocus();
  });
});
