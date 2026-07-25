import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { fireEvent, render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ApplicationShortcuts } from "./ApplicationShortcuts";

describe("ApplicationShortcuts", () => {
  beforeEach(() => {
    vi.mocked(invoke).mockClear();
    vi.mocked(getCurrentWindow().close).mockClear();
  });

  it("通过 Ctrl+Q 请求优雅退出程序", () => {
    render(<ApplicationShortcuts />);

    fireEvent.keyDown(window, { ctrlKey: true, key: "q" });

    expect(invoke).toHaveBeenCalledOnce();
    expect(invoke).toHaveBeenCalledWith("quit_application");
    expect(getCurrentWindow().close).not.toHaveBeenCalled();
  });

  it("通过 Ctrl+Shift+W 关闭当前窗口", () => {
    render(<ApplicationShortcuts />);

    fireEvent.keyDown(window, { ctrlKey: true, key: "W", shiftKey: true });

    expect(getCurrentWindow().close).toHaveBeenCalledOnce();
    expect(invoke).not.toHaveBeenCalled();
  });

  it("不接管关闭标签页和包含其他修饰键的组合", () => {
    render(<ApplicationShortcuts />);

    fireEvent.keyDown(window, { ctrlKey: true, key: "w" });
    fireEvent.keyDown(window, { altKey: true, ctrlKey: true, key: "q" });
    fireEvent.keyDown(window, { ctrlKey: true, key: "q", repeat: true });

    expect(getCurrentWindow().close).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalled();
  });
});
