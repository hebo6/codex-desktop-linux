import { describe, expect, it, vi } from "vitest";

import { prepareHtmlPreview, type HtmlPreviewFile } from "./htmlPreview";

function base64For(text: string): string {
  return btoa(String.fromCharCode(...new TextEncoder().encode(text)));
}

function file(text: string): HtmlPreviewFile {
  return {
    dataBase64: base64For(text),
    isFile: true,
    isSymlink: false,
  };
}

describe("prepareHtmlPreview", () => {
  it("移除可执行内容并为文档注入最小 CSP", async () => {
    const prepared = await prepareHtmlPreview({
      createBlobUrl: vi.fn(() => "blob:unused"),
      documentPath: "/workspace/index.html",
      loadFile: vi.fn(async () => file("")),
      source: `
        <html>
          <head>
            <meta http-equiv="refresh" content="0;url=https://evil.test">
            <style>body { color: red; }</style>
          </head>
          <body onload="steal()">
            <script>steal()</script>
            <iframe src="https://evil.test"></iframe>
            <form action="https://evil.test"><button formaction="https://evil.test">提交</button></form>
            <p style="font-weight: bold">内容</p>
          </body>
        </html>
      `,
      workspacePath: "/workspace",
    });

    expect(prepared.html).toContain(
      "default-src 'none'; base-uri 'none'; connect-src 'none'",
    );
    expect(prepared.html).not.toContain("<script");
    expect(prepared.html).not.toContain("<iframe");
    expect(prepared.html).not.toContain("<style");
    expect(prepared.html).not.toMatch(/\sstyle=/u);
    expect(prepared.html).not.toContain("'unsafe-inline'");
    expect(prepared.html).toContain('href="blob:unused"');
    expect(prepared.html).not.toContain("onload=");
    expect(prepared.html).not.toContain("formaction=");
    expect(prepared.html).not.toContain("action=");
    expect(prepared.html).not.toContain("http-equiv=\"refresh\"");
  });

  it("只读取工作区内的相对样式、图片和字体", async () => {
    const files = new Map<string, HtmlPreviewFile>([
      [
        "/workspace/styles/site.css",
        file(`
          @import "https://evil.test/remote.css";
          body { background: url("../images/background.png"); }
          @font-face { src: url("../fonts/site.woff2"); }
        `),
      ],
      ["/workspace/images/background.png", file("background")],
      ["/workspace/images/logo.png", file("logo")],
      ["/workspace/fonts/site.woff2", file("font")],
    ]);
    const loadFile = vi.fn(async (path: string) => {
      const loaded = files.get(path);
      if (loaded === undefined) {
        throw new Error(`unexpected path: ${path}`);
      }
      return loaded;
    });
    let blobSequence = 0;

    const prepared = await prepareHtmlPreview({
      createBlobUrl: vi.fn(
        (blob) => `blob:${blob.type}:${blobSequence += 1}`,
      ),
      documentPath: "/workspace/pages/index.html",
      loadFile,
      source: `
        <link rel="stylesheet" href="../styles/site.css">
        <img src="../images/logo.png" srcset="https://evil.test/logo.png 2x">
        <img src="https://evil.test/tracker.png">
        <img src="../../outside.png">
      `,
      workspacePath: "/workspace",
    });

    expect(loadFile).toHaveBeenCalledWith("/workspace/styles/site.css");
    expect(loadFile).toHaveBeenCalledWith("/workspace/images/background.png");
    expect(loadFile).toHaveBeenCalledWith("/workspace/images/logo.png");
    expect(loadFile).toHaveBeenCalledWith("/workspace/fonts/site.woff2");
    expect(loadFile).not.toHaveBeenCalledWith("/outside.png");
    expect(prepared.html).toContain('href="blob:text/css:');
    expect(prepared.html).toContain('src="blob:image/png:');
    expect(prepared.html).not.toContain("srcset=");
    expect(prepared.html).not.toContain("https://evil.test/tracker.png");
    expect(prepared.blockedResourceCount).toBe(3);
  });

  it("将 HTML 链接交给应用处理并保留页内锚点", async () => {
    const prepared = await prepareHtmlPreview({
      createBlobUrl: vi.fn(() => "blob:unused"),
      documentPath: "/workspace/docs/index.html",
      loadFile: vi.fn(async () => file("")),
      source: `
        <a href="../guide.html#intro">指南</a>
        <a href="https://example.com/docs">网页</a>
        <a href="//example.org/docs">协议相对网页</a>
        <a href="#local">页内</a>
        <a href="javascript:steal()">危险</a>
      `,
      workspacePath: "/workspace",
    });

    expect(prepared.html).toContain(
      'data-preview-link="/workspace/guide.html#intro"',
    );
    expect(prepared.html).toContain(
      'data-preview-link="https://example.com/docs"',
    );
    expect(prepared.html).toContain(
      'data-preview-link="https://example.org/docs"',
    );
    expect(prepared.html).toContain('href="#local"');
    expect(prepared.html).not.toContain("javascript:steal()");
  });

  it("在 Windows 工作区中规范化相对资源路径", async () => {
    const loadFile = vi.fn(async () => file("logo"));

    await prepareHtmlPreview({
      createBlobUrl: vi.fn(() => "blob:logo"),
      documentPath: "C:\\workspace\\pages\\index.html",
      loadFile,
      source: '<img src="..\\images\\logo.png">',
      workspacePath: "C:\\workspace",
    });

    expect(loadFile).toHaveBeenCalledWith("C:/workspace/images/logo.png");
  });
});
