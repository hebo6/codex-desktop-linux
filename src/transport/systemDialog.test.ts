import { describe, expect, it, vi } from "vitest";

import type { TauriIpc } from "./tauriIpc";
import {
  openExternalUrl,
  openHtmlInBrowser,
  pickLocalDirectory,
  saveRemoteFile,
} from "./systemDialog";

describe("pickLocalDirectory", () => {
  it("只接受本机绝对目录或取消结果", async () => {
    const ipc = { invoke: vi.fn(async () => "/workspace/project") } as unknown as TauriIpc;
    await expect(pickLocalDirectory(ipc)).resolves.toBe("/workspace/project");
    expect(ipc.invoke).toHaveBeenCalledWith("pick_local_directory", {});

    const cancelled = { invoke: vi.fn(async () => null) } as unknown as TauriIpc;
    await expect(pickLocalDirectory(cancelled)).resolves.toBeNull();

    const invalid = { invoke: vi.fn(async () => "relative") } as unknown as TauriIpc;
    await expect(pickLocalDirectory(invalid)).rejects.toThrow("无效路径");
  });

  it("通过受限 Rust 命令打开网页、HTML 和另存远程内容", async () => {
    const ipc = { invoke: vi.fn(async () => null) } as unknown as TauriIpc;
    await openExternalUrl("https://example.com/path", ipc);
    await openHtmlInBrowser("PGgxPkhlbGxvPC9oMT4=", ipc);
    await saveRemoteFile("aGVsbG8=", "note.txt", false, ipc);
    expect(ipc.invoke).toHaveBeenNthCalledWith(1, "open_external_url", {
      url: "https://example.com/path",
    });
    expect(ipc.invoke).toHaveBeenNthCalledWith(2, "open_html_in_browser", {
      dataBase64: "PGgxPkhlbGxvPC9oMT4=",
    });
    expect(ipc.invoke).toHaveBeenNthCalledWith(3, "save_remote_file", {
      dataBase64: "aGVsbG8=",
      suggestedName: "note.txt",
      allowLarge: false,
    });
  });
});
