import { describe, expect, it, vi } from "vitest";

import type { FileClient } from "../appServer";
import type { RequestHandle } from "../protocol/rpc";
import { resolveLink } from "./linkResolver";
import { loadMarkdownImage } from "./markdownImage";

const PNG_BASE64 = "iVBORw0KGgo=";
const PNG_DATA_URL = `data:image/png;base64,${PNG_BASE64}`;

function handle<T>(value: T): RequestHandle<T> {
  return { epoch: 1, id: 1, stage: "pending", result: Promise.resolve(value) };
}

function clientFor(dataBase64 = PNG_BASE64, isFile = true): FileClient {
  return {
    getMetadata: vi.fn(() => handle({
      createdAtMs: 1,
      modifiedAtMs: 1,
      isDirectory: !isFile,
      isFile,
      isSymlink: false,
    })),
    readFile: vi.fn(() => handle({ dataBase64 })),
  };
}

describe("loadMarkdownImage", () => {
  it.each([
    ["../images/screen%20shot.png", "/remote/project/docs", "/remote/project/images/screen shot.png", "/remote/project/images/screen%20shot.png"],
    ["./screen shot.PNG", "/remote/project", "/remote/project/screen shot.PNG", "/remote/project/screen%20shot.PNG"],
    ["file:///remote/images/screen%20shot.png", null, "/remote/images/screen shot.png", "/remote/images/screen%20shot.png"],
    ["/remote/images/screen.png", "/different/project", "/remote/images/screen.png", "/remote/images/screen.png"],
  ])("根据服务器工作目录解析 %s 并绑定预览路径", async (source, cwd, path, target) => {
    const client = clientFor();
    const remoteReader = vi.fn();

    const image = await loadMarkdownImage(source, client, cwd, remoteReader);

    expect(client.getMetadata).toHaveBeenCalledExactlyOnceWith(path);
    expect(client.readFile).toHaveBeenCalledExactlyOnceWith(path);
    expect(image.target).toBe(target);
    expect(image.blob.type).toBe("image/png");
    await expect(image.blob.arrayBuffer()).resolves.toEqual(
      new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).buffer,
    );
    expect(remoteReader).not.toHaveBeenCalled();
  });

  it.each([
    ["./screen%23capture.png", "/remote", "/remote/screen#capture.png"],
    ["./screen%2520capture.png", "/remote", "/remote/screen%20capture.png"],
    ["./screen%252Fcapture.png", "/remote", "/remote/screen%2Fcapture.png"],
    ["screen%23capture%2520.png", "C:\\remote", "C:\\remote\\screen#capture%20.png"],
  ])("点击预览 %s 时保留文件名中的井号和字面百分号编码", async (source, cwd, path) => {
    const client = clientFor();

    const image = await loadMarkdownImage(source, client, cwd);

    expect(client.readFile).toHaveBeenCalledExactlyOnceWith(path);
    expect(resolveLink(image.target, cwd)).toMatchObject({ type: "file", path });
  });

  it("拒绝读取名称带图片扩展名的目录", async () => {
    const client = clientFor(PNG_BASE64, false);

    await expect(loadMarkdownImage("folder.png", client, "/remote"))
      .rejects.toThrow("此路径不是图片文件");

    expect(client.readFile).not.toHaveBeenCalled();
  });

  it("服务器断连时提供错误，不尝试通过互联网读取文件", async () => {
    const remoteReader = vi.fn();

    await expect(loadMarkdownImage("screen.png", null, "/remote", remoteReader))
      .rejects.toThrow("当前服务器连接不可用");

    expect(remoteReader).not.toHaveBeenCalled();
  });

  it.each([
    ["javascript:alert(1)", "/remote"],
    ["blob:https://example.test/id", "/remote"],
    ["ftp://example.test/image.png", "/remote"],
    ["https://secret@example.test/image.png", "/remote"],
    ["file://another-host/image.png", "/remote"],
    ["screen.png", null],
    ["#screen", "/remote"],
    ["screen.txt", "/remote"],
  ])("来源 %s 不满足图片读取条件时不发请求", async (source, cwd) => {
    const client = clientFor();
    const remoteReader = vi.fn();

    await expect(loadMarkdownImage(source, client, cwd, remoteReader)).rejects.toThrow();

    expect(client.getMetadata).not.toHaveBeenCalled();
    expect(client.readFile).not.toHaveBeenCalled();
    expect(remoteReader).not.toHaveBeenCalled();
  });

  it("文件读取失败时保留服务器错误", async () => {
    const client = clientFor();
    vi.mocked(client.readFile).mockImplementation(() => ({
      ...handle({ dataBase64: "" }),
      result: Promise.reject(new Error("文件已被删除")),
    }));

    await expect(loadMarkdownImage("screen.png", client, "/remote"))
      .rejects.toThrow("文件已被删除");
  });

  it("拒绝超过 16 MiB 的文件和内嵌图片", async () => {
    const oversizedBase64 = "A".repeat(Math.ceil((16 * 1024 * 1024 + 1) / 3) * 4);

    await expect(loadMarkdownImage("large.png", clientFor(oversizedBase64), "/remote"))
      .rejects.toThrow("图片超过 16 MiB");
    await expect(loadMarkdownImage(`data:image/png;base64,${oversizedBase64}`, null, null))
      .rejects.toThrow("超过 16 MiB");
  });

  it("清洗文件 SVG 中的脚本、事件和外部引用", async () => {
    const source = '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script><image href="https://example.test/tracker.png" onload="alert(1)"/><path fill="red" d="M0 0h1"/></svg>';

    const image = await loadMarkdownImage("diagram.svg", clientFor(btoa(source)), "/remote");
    const svg = await image.blob.text();

    expect(image.blob.type).toBe("image/svg+xml;charset=utf-8");
    expect(svg).toContain('fill="red"');
    expect(svg).not.toMatch(/script|onload|example\.test/u);
  });

  it("拒绝无效 Base64 文件内容", async () => {
    await expect(loadMarkdownImage("screen.png", clientFor("%%%"), "/remote"))
      .rejects.toThrow("图片内容无效");
  });

  it("内嵌位图在服务器离线时仍可解码和预览", async () => {
    const remoteReader = vi.fn();

    const image = await loadMarkdownImage(PNG_DATA_URL, null, null, remoteReader);

    expect(image.target).toBe(PNG_DATA_URL);
    expect(image.blob.type).toBe("image/png");
    expect(image.blob.size).toBe(8);
    expect(remoteReader).not.toHaveBeenCalled();
  });

  it.each([
    "data:image/svg+xml;base64,PHN2Zy8+",
    "data:text/html;base64,PGgxPkhlbGxvPC9oMT4=",
    "data:image/png;base64,%%%",
    "data:image/png,raw-image",
  ])("拒绝不支持或无效的内嵌图片 %s", async (source) => {
    const remoteReader = vi.fn();

    await expect(loadMarkdownImage(source, null, null, remoteReader))
      .rejects.toThrow("图片数据无效");

    expect(remoteReader).not.toHaveBeenCalled();
  });

  it.each(["https", "http"])("自动读取 %s 图片并让预览复用已下载内容", async (scheme) => {
    const client = clientFor();
    const remoteReader = vi.fn(async () => PNG_DATA_URL);

    const image = await loadMarkdownImage(`${scheme}://Example.test/screen shot.png`, client, null, remoteReader);

    expect(remoteReader).toHaveBeenCalledExactlyOnceWith(`${scheme}://example.test/screen%20shot.png`);
    expect(client.getMetadata).not.toHaveBeenCalled();
    expect(client.readFile).not.toHaveBeenCalled();
    expect(image.target).toBe(PNG_DATA_URL);
    expect(image.blob.type).toBe("image/png");
    expect(image.blob.size).toBe(8);
  });

  it.each([
    "data:text/html;base64,PGgxPkhlbGxvPC9oMT4=",
    "data:image/svg+xml;base64,PHN2Zy8+",
    "data:image/png;base64,%%%",
    "https://another.test/image.png",
  ])("互联网读取结果无效时拒绝渲染 %s", async (response) => {
    await expect(loadMarkdownImage("https://example.test/image.png", null, null, async () => response))
      .rejects.toThrow("服务器返回了无效的图片数据");
  });
});
