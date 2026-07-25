import { describe, expect, it, vi } from "vitest";

import type { TauriIpc } from "./tauriIpc";
import { readClipboardFiles } from "./clipboard";

describe("readClipboardFiles", () => {
  it("解码本机剪贴板文件并保留逐文件错误", async () => {
    const ipc = {
      invoke: vi.fn(async () => [
        {
          name: "screen.png",
          size: 8,
          dataBase64: "iVBORw0KGgo=",
          error: null,
        },
        {
          name: "large.png",
          size: 16 * 1024 * 1024 + 1,
          dataBase64: null,
          error: "图片超过 16 MiB 上限",
        },
      ]),
    } as unknown as TauriIpc;

    const files = await readClipboardFiles(ipc);

    expect(ipc.invoke).toHaveBeenCalledWith("read_clipboard_files", {});
    expect(files[0]).toMatchObject({
      name: "screen.png",
      size: 8,
      error: null,
      file: expect.any(File),
    });
    await expect(files[0]?.file?.arrayBuffer()).resolves.toEqual(
      new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).buffer,
    );
    expect(files[1]).toEqual({
      name: "large.png",
      size: 16 * 1024 * 1024 + 1,
      file: null,
      error: "图片超过 16 MiB 上限",
    });
  });

  it("拒绝结构无效或大小不一致的响应", async () => {
    const invalidShape = {
      invoke: vi.fn(async () => [{ name: "screen.png", size: 1 }]),
    } as unknown as TauriIpc;
    await expect(readClipboardFiles(invalidShape)).rejects.toThrow("无效文件");

    const invalidSize = {
      invoke: vi.fn(async () => [{
        name: "screen.png",
        size: 9,
        dataBase64: "iVBORw0KGgo=",
        error: null,
      }]),
    } as unknown as TauriIpc;
    await expect(readClipboardFiles(invalidSize)).rejects.toThrow("大小不一致");
  });
});
