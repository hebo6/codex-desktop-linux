import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ApplicationShortcuts } from "./ApplicationShortcuts";

const appWindow = getCurrentWindow();
const isFullscreen = vi.mocked(appWindow.isFullscreen);
const setFullscreen = vi.mocked(appWindow.setFullscreen);

describe("ApplicationShortcuts", () => {
  beforeEach(() => {
    vi.mocked(invoke).mockClear();
    vi.mocked(getCurrentWindow().close).mockClear();
    isFullscreen.mockReset().mockResolvedValue(false);
    setFullscreen.mockReset().mockResolvedValue(undefined);
  });

  it("在输入框中按 F11 进入全屏，再按一次根据原生窗口状态退出", async () => {
    render(<><ApplicationShortcuts /><textarea aria-label="消息" /></>);
    const input = screen.getByRole("textbox", { name: "消息" });
    input.focus();

    expect(fireEvent.keyDown(input, { key: "F11" })).toBe(false);
    await waitFor(() => expect(setFullscreen).toHaveBeenNthCalledWith(1, true));

    isFullscreen.mockResolvedValue(true);
    expect(fireEvent.keyDown(input, { key: "F11" })).toBe(false);
    await waitFor(() => expect(setFullscreen).toHaveBeenNthCalledWith(2, false));
    expect(isFullscreen).toHaveBeenCalledTimes(2);
    expect(input).toHaveFocus();
    expect(invoke).not.toHaveBeenCalled();
    expect(appWindow.close).not.toHaveBeenCalled();
  });

  it.each([
    { ctrlKey: true },
    { shiftKey: true },
    { altKey: true },
    { metaKey: true },
    { repeat: true },
    { isComposing: true },
  ])("忽略带修饰键、长按或输入法合成的 F11：%j", (options) => {
    render(<ApplicationShortcuts />);

    expect(fireEvent.keyDown(window, { key: "F11", ...options })).toBe(true);
    expect(isFullscreen).not.toHaveBeenCalled();
    expect(setFullscreen).not.toHaveBeenCalled();
  });

  it("已被控件消费的 F11 不切换全屏，卸载后不再监听", () => {
    const { unmount } = render(<ApplicationShortcuts />);
    const event = new KeyboardEvent("keydown", { key: "F11", cancelable: true });
    event.preventDefault();
    fireEvent(window, event);

    unmount();
    fireEvent.keyDown(window, { key: "F11" });

    expect(isFullscreen).not.toHaveBeenCalled();
    expect(setFullscreen).not.toHaveBeenCalled();
  });

  it("切换尚未完成时不重复请求，失败后允许重试", async () => {
    let rejectToggle!: (error: Error) => void;
    setFullscreen.mockImplementationOnce(() => new Promise<void>((_, reject) => {
      rejectToggle = reject;
    }));
    const logError = vi.spyOn(console, "error").mockImplementation(() => {});
    render(<ApplicationShortcuts />);

    fireEvent.keyDown(window, { key: "F11" });
    await waitFor(() => expect(setFullscreen).toHaveBeenCalledOnce());
    fireEvent.keyDown(window, { key: "F11" });
    expect(isFullscreen).toHaveBeenCalledOnce();

    const error = new Error("窗口操作失败");
    rejectToggle(error);
    await waitFor(() => expect(logError).toHaveBeenCalledWith("切换全屏失败", error));

    fireEvent.keyDown(window, { key: "F11" });
    await waitFor(() => expect(setFullscreen).toHaveBeenCalledTimes(2));
    expect(setFullscreen).toHaveBeenLastCalledWith(true);
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
