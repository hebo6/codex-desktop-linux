import { PhysicalSize } from "@tauri-apps/api/dpi";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ApplicationShortcuts } from "./ApplicationShortcuts";
import { FullscreenButton } from "./FullscreenButton";

const appWindow = getCurrentWindow();
const isFullscreen = vi.mocked(appWindow.isFullscreen);
const setFullscreen = vi.mocked(appWindow.setFullscreen);
const onResized = vi.mocked(appWindow.onResized);

describe("FullscreenButton", () => {
  let nativeFullscreen: boolean;
  let notifyResize: () => void;

  beforeEach(() => {
    nativeFullscreen = false;
    isFullscreen.mockReset().mockImplementation(async () => nativeFullscreen);
    setFullscreen.mockReset().mockImplementation(async (value) => {
      nativeFullscreen = value;
    });
    onResized.mockReset().mockImplementation(async (listener) => {
      notifyResize = () => listener({ event: "tauri://resize", id: 1, payload: new PhysicalSize(1280, 800) });
      return vi.fn<() => void>();
    });
  });

  it("鼠标切换原生全屏，即使没有尺寸事件也更新退出入口", async () => {
    render(<FullscreenButton />);
    const button = screen.getByRole("button", { name: "进入全屏" });
    await waitFor(() => expect(button).toBeEnabled());
    expect(button).toHaveAttribute("title", "进入全屏（F11）");
    fireEvent.click(button);

    await waitFor(() => expect(button).toHaveAccessibleName("退出全屏"));
    expect(button).toHaveAttribute("title", "退出全屏（F11）");
    expect(setFullscreen).toHaveBeenLastCalledWith(true);
    await waitFor(() => expect(button).toBeEnabled());
    fireEvent.click(button);
    await waitFor(() => expect(button).toHaveAccessibleName("进入全屏"));
    expect(setFullscreen).toHaveBeenLastCalledWith(false);
    expect(appWindow.toggleMaximize).not.toHaveBeenCalled();
  });

  it("恢复已全屏的窗口，并跟随 F11 与系统窗口状态更新", async () => {
    nativeFullscreen = true;
    render(<><ApplicationShortcuts /><FullscreenButton /></>);
    const button = await screen.findByRole("button", { name: "退出全屏" });
    fireEvent.keyDown(window, { key: "F11" });
    await waitFor(() => expect(setFullscreen).toHaveBeenCalledWith(false));
    await act(async () => notifyResize());
    expect(button).toHaveAccessibleName("进入全屏");

    nativeFullscreen = true;
    await act(async () => notifyResize());
    expect(button).toHaveAccessibleName("退出全屏");
    expect(setFullscreen).toHaveBeenCalledOnce();
  });

  it("鼠标与 F11 共用切换锁，失败后可以再次操作", async () => {
    let rejectToggle!: (error: Error) => void;
    setFullscreen.mockImplementationOnce(() => new Promise<void>((_, reject) => {
      rejectToggle = reject;
    }));
    const logError = vi.spyOn(console, "error").mockImplementation(() => {});
    render(<><ApplicationShortcuts /><FullscreenButton /></>);
    const button = screen.getByRole("button", { name: "进入全屏" });
    await waitFor(() => expect(button).toBeEnabled());
    fireEvent.click(button);
    await waitFor(() => expect(setFullscreen).toHaveBeenCalledOnce());
    expect(button).toBeDisabled();
    fireEvent.keyDown(window, { key: "F11" });
    expect(setFullscreen).toHaveBeenCalledOnce();

    const error = new Error("窗口操作失败");
    await act(async () => rejectToggle(error));
    expect(logError).toHaveBeenCalledWith("切换全屏失败", error);
    expect(button).toBeEnabled();
    expect(button).toHaveAccessibleName("进入全屏");
    fireEvent.click(button);
    await waitFor(() => expect(button).toHaveAccessibleName("退出全屏"));
    expect(setFullscreen).toHaveBeenCalledTimes(2);
  });

  it("较早的异步读取不能覆盖最新窗口状态，卸载后移除监听", async () => {
    let resolveInitial!: (value: boolean) => void;
    isFullscreen.mockImplementationOnce(() => new Promise<boolean>((resolve) => {
      resolveInitial = resolve;
    }));
    const dispose = vi.fn();
    onResized.mockImplementationOnce(async (listener) => {
      notifyResize = () => listener({ event: "tauri://resize", id: 1, payload: new PhysicalSize(1280, 800) });
      return dispose;
    });
    const { unmount } = render(<FullscreenButton />);
    nativeFullscreen = true;
    await act(async () => notifyResize());
    await act(async () => resolveInitial(false));
    expect(screen.getByRole("button", { name: "退出全屏" })).toBeEnabled();
    unmount();
    await waitFor(() => expect(dispose).toHaveBeenCalledOnce());
  });
});
