import { describe, expect, it, vi } from "vitest";

import { readRemoteImage } from "./remoteImage";
import type { TauriIpc } from "./tauriIpc";

describe("readRemoteImage", () => {
  it("通过桌面命令读取互联网图片并返回可复用的 Data URL", async () => {
    const ipc = {
      invoke: vi.fn(async () => ({ dataBase64: "iVBORw0KGgo=", mediaType: "image/png" })),
    } as unknown as TauriIpc;

    await expect(readRemoteImage("https://example.test/screen%20shot.png", ipc))
      .resolves.toBe("data:image/png;base64,iVBORw0KGgo=");

    expect(ipc.invoke).toHaveBeenCalledExactlyOnceWith("read_remote_image", {
      url: "https://example.test/screen%20shot.png",
    });
  });

  it("保留桌面端的请求失败原因", async () => {
    const ipc = {
      invoke: vi.fn(async () => { throw new Error("图片下载超时"); }),
    } as unknown as TauriIpc;

    await expect(readRemoteImage("https://example.test/image.png", ipc))
      .rejects.toThrow("图片下载超时");
  });
});
