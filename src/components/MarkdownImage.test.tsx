import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { FileClient } from "../appServer";
import type { RequestHandle } from "../protocol/rpc";
import { readRemoteImage } from "../transport/remoteImage";
import { MarkdownImageContext } from "./MarkdownImage";
import { SafeMarkdown } from "./SafeMarkdown";

vi.mock("../transport/remoteImage", () => ({ readRemoteImage: vi.fn() }));

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==";
const DATA_URL = `data:image/png;base64,${PNG}`;
const create = vi.fn();
const revoke = vi.fn();

function handle<T>(result: Promise<T>): RequestHandle<T> {
  return { epoch: 1, id: 1, stage: "pending", result };
}

function clientFor(read: () => Promise<{ dataBase64: string }> = async () => ({ dataBase64: PNG })): FileClient {
  return {
    getMetadata: vi.fn(() => handle(Promise.resolve({
      createdAtMs: 0, modifiedAtMs: 0, isDirectory: false, isFile: true, isSymlink: false,
    }))),
    readFile: vi.fn(() => handle(read())),
  };
}

beforeEach(() => {
  let sequence = 0;
  create.mockReset().mockImplementation(() => `blob:image-${++sequence}`);
  revoke.mockReset();
  vi.stubGlobal("URL", class extends URL {
    static override createObjectURL = create;
    static override revokeObjectURL = revoke;
  });
  vi.mocked(readRemoteImage).mockReset().mockResolvedValue(DATA_URL);
});

afterEach(() => vi.unstubAllGlobals());

describe("Markdown 图片", () => {
  it("渲染服务器截图，保留描述和标题，点击预览绝对路径", async () => {
    const client = clientFor();
    const onOpenLink = vi.fn();
    const { unmount } = render(
      <MarkdownImageContext value={{ client, cwd: "/remote/project" }}>
        <SafeMarkdown onOpenLink={onOpenLink} source={'当前桌面截图：\n\n![桌面截图](<./screen shot.png> "截图标题")'} />
      </MarkdownImageContext>,
    );
    const image = await screen.findByRole("img", { name: "桌面截图" });
    expect(image).toHaveAttribute("src", "blob:image-1");
    expect(image).toHaveAttribute("title", "截图标题");
    expect(client.readFile).toHaveBeenCalledExactlyOnceWith("/remote/project/screen shot.png");
    fireEvent.click(screen.getByRole("button", { name: "查看图片：桌面截图" }));
    expect(onOpenLink).toHaveBeenCalledExactlyOnceWith("/remote/project/screen%20shot.png");
    unmount();
    expect(revoke).toHaveBeenCalledExactlyOnceWith("blob:image-1");
  });

  it("互联网图片自动加载为 Blob，放大复用下载数据且流式更新不重复请求", async () => {
    const onOpenLink = vi.fn();
    const source = "![网络图](https://example.com/image.png)";
    const { rerender } = render(<SafeMarkdown onOpenLink={onOpenLink} source={source} />);
    const image = await screen.findByRole("img", { name: "网络图" });
    expect(image).toHaveAttribute("src", "blob:image-1");
    expect(readRemoteImage).toHaveBeenCalledExactlyOnceWith("https://example.com/image.png");
    fireEvent.click(screen.getByRole("button", { name: "查看图片：网络图" }));
    expect(onOpenLink).toHaveBeenCalledExactlyOnceWith(DATA_URL);
    rerender(<SafeMarkdown onOpenLink={onOpenLink} source={`${source}\n\n后续正文`} />);
    expect(screen.getByRole("img", { name: "网络图" })).toBe(image);
    expect(readRemoteImage).toHaveBeenCalledTimes(1);
  });

  it("读取或浏览器解码失败时显示原因并可重试", async () => {
    vi.mocked(readRemoteImage).mockRejectedValueOnce("图片下载超时");
    render(<SafeMarkdown source="![网络图](https://example.com/image.png)" />);
    expect(await screen.findByText("网络图：图片下载超时")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    fireEvent.error(await screen.findByRole("img", { name: "网络图" }));
    expect(screen.getByText("网络图：图片无法解码")).toBeVisible();
    expect(revoke).toHaveBeenCalledWith("blob:image-1");
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(await screen.findByRole("img", { name: "网络图" })).toHaveAttribute("src", "blob:image-2");
    expect(readRemoteImage).toHaveBeenCalledTimes(3);
  });

  it("更换图片后忽略旧请求的迟到结果", async () => {
    let finishOld: ((value: string) => void) | undefined;
    vi.mocked(readRemoteImage).mockImplementationOnce(() => new Promise((resolve) => { finishOld = resolve; }));
    const { rerender } = render(<SafeMarkdown source="![旧图](https://example.com/old.png)" />);
    rerender(<SafeMarkdown source={`![新图](${DATA_URL})`} />);
    expect(await screen.findByRole("img", { name: "新图" })).toHaveAttribute("src", "blob:image-1");
    await act(async () => { finishOld?.(DATA_URL); });
    expect(screen.queryByRole("img", { name: "旧图" })).not.toBeInTheDocument();
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("相同相对路径切换服务器和目录时释放旧图并重新读取", async () => {
    const first = clientFor();
    const second = clientFor();
    const content = <SafeMarkdown source="![图片](image.png)" />;
    const { rerender } = render(<MarkdownImageContext value={{ client: first, cwd: "/first" }}>{content}</MarkdownImageContext>);
    await screen.findByRole("img", { name: "图片" });
    rerender(<MarkdownImageContext value={{ client: second, cwd: "/second" }}>{content}</MarkdownImageContext>);
    await waitFor(() => expect(screen.getByRole("img", { name: "图片" })).toHaveAttribute("src", "blob:image-2"));
    expect(first.readFile).toHaveBeenCalledWith("/first/image.png");
    expect(second.readFile).toHaveBeenCalledWith("/second/image.png");
    expect(revoke).toHaveBeenCalledWith("blob:image-1");
  });

  it("紧凑摘要只保留图片描述，不读取图片或挂载按钮", () => {
    const client = clientFor();
    render(<MarkdownImageContext value={{ client, cwd: "/remote" }}>
      <SafeMarkdown onOpenLink={vi.fn()} source="![本地图](image.png) ![网络图](https://example.com/image.png)" variant="compact" />
    </MarkdownImageContext>);
    expect(screen.getByText("图片：本地图")).toBeVisible();
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(client.readFile).not.toHaveBeenCalled();
    expect(readRemoteImage).not.toHaveBeenCalled();
  });

  it("链接内已加载图片由外层链接响应点击，失败也不嵌套重试按钮", async () => {
    const onOpenLink = vi.fn();
    const { container } = render(<SafeMarkdown onOpenLink={onOpenLink} source={`[![图](${DATA_URL})](https://example.com)`} />);
    const image = await screen.findByRole("img", { name: "图" });
    fireEvent.click(image);
    expect(onOpenLink).toHaveBeenCalledExactlyOnceWith("https://example.com");
    fireEvent.error(image);
    expect(container.querySelector("button button")).toBeNull();
    expect(screen.queryByRole("button", { name: "重试" })).not.toBeInTheDocument();
  });
});
