import { PhysicalSize } from "@tauri-apps/api/dpi";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { act, fireEvent, render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { WindowResizeHandles } from "./WindowResizeHandles";

const appWindow = getCurrentWindow();
const isMaximized = vi.mocked(appWindow.isMaximized);
const isFullscreen = vi.mocked(appWindow.isFullscreen);
const onResized = vi.mocked(appWindow.onResized);

describe("WindowResizeHandles", () => {
  beforeEach(() => {
    isMaximized.mockReset().mockResolvedValue(false);
    isFullscreen.mockReset().mockResolvedValue(false);
    onResized.mockClear();
    vi.mocked(appWindow.startResizeDragging).mockClear();
  });

  it.each([
    { maximized: false, fullscreen: true },
    { maximized: true, fullscreen: false },
    { maximized: true, fullscreen: true },
  ])("初始窗口状态为 %j 时不显示缩放热区", async ({ maximized, fullscreen }) => {
    isMaximized.mockResolvedValue(maximized);
    isFullscreen.mockResolvedValue(fullscreen);
    const { container } = await act(async () => render(<WindowResizeHandles />));

    expect(container).toBeEmptyDOMElement();
    expect(isFullscreen).toHaveBeenCalledOnce();
  });

  it("进入全屏后隐藏热区，退出后恢复原生缩放操作，卸载时退订", async () => {
    const unlisten = vi.fn();
    onResized.mockResolvedValueOnce(unlisten);
    const { container, unmount } = render(<WindowResizeHandles />);
    const notifyResize = async () => {
      await act(async () => {
        onResized.mock.calls[0]![0]({
          event: "tauri://resize",
          id: 1,
          payload: new PhysicalSize(1920, 1080),
        });
      });
    };
    await waitFor(() => expect(container.firstElementChild?.children).toHaveLength(8));

    isFullscreen.mockResolvedValue(true);
    await notifyResize();
    expect(container).toBeEmptyDOMElement();

    isFullscreen.mockResolvedValue(false);
    await notifyResize();
    expect(container.firstElementChild?.children).toHaveLength(8);
    fireEvent.mouseDown(container.firstElementChild!.firstElementChild!);
    expect(appWindow.startResizeDragging).toHaveBeenCalledWith("North");

    unmount();
    await waitFor(() => expect(unlisten).toHaveBeenCalledOnce());
  });
});
