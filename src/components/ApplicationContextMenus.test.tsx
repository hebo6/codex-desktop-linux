import {
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { getCurrentWindow } from "@tauri-apps/api/window";

import { ApplicationContextMenus } from "./ApplicationContextMenus";

const appWindow = getCurrentWindow();
const isMaximized = vi.mocked(appWindow.isMaximized);
const minimize = vi.mocked(appWindow.minimize);
const toggleMaximize = vi.mocked(appWindow.toggleMaximize);

describe("ApplicationContextMenus", () => {
  beforeEach(() => {
    isMaximized.mockReset();
    isMaximized.mockResolvedValue(false);
    minimize.mockClear();
    toggleMaximize.mockClear();
  });

  it("屏蔽 WebView 默认菜单但保留应用自定义处理", () => {
    const onContextMenu = vi.fn();
    render(
      <>
        <ApplicationContextMenus />
        <textarea aria-label="编辑内容" />
        <button onContextMenu={onContextMenu} type="button">自定义菜单</button>
      </>,
    );

    const textareaEvent = dispatchContextMenu(
      screen.getByRole("textbox", { name: "编辑内容" }),
    );
    const customEvent = dispatchContextMenu(
      screen.getByRole("button", { name: "自定义菜单" }),
    );

    expect(textareaEvent.defaultPrevented).toBe(true);
    expect(customEvent.defaultPrevented).toBe(true);
    expect(onContextMenu).toHaveBeenCalledOnce();
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("仅在显式窗口区域打开菜单并执行窗口操作", async () => {
    render(
      <>
        <ApplicationContextMenus />
        <header data-window-menu-region="self">
          <span data-window-menu-region="deep"><strong>窗口标题</strong></span>
          <button aria-label="设置" type="button" />
        </header>
      </>,
    );

    fireEvent.contextMenu(screen.getByText("窗口标题"), {
      clientX: 120,
      clientY: 80,
    });
    fireEvent.click(await screen.findByRole("menuitem", { name: "最大化" }));
    expect(toggleMaximize).toHaveBeenCalledOnce();

    fireEvent.contextMenu(screen.getByRole("banner"));
    fireEvent.click(await screen.findByRole("menuitem", { name: "最小化" }));
    expect(minimize).toHaveBeenCalledOnce();

    fireEvent.contextMenu(screen.getByRole("button", { name: "设置" }));
    await waitFor(() =>
      expect(screen.queryByRole("menu")).not.toBeInTheDocument()
    );
  });

  it("按窗口状态显示还原并支持键盘导航和焦点恢复", async () => {
    isMaximized.mockResolvedValueOnce(true);
    render(
      <>
        <ApplicationContextMenus />
        <button type="button">原焦点</button>
        <span data-window-menu-region="self">拖拽区</span>
      </>,
    );
    const returnFocus = screen.getByRole("button", { name: "原焦点" });
    returnFocus.focus();

    fireEvent.contextMenu(screen.getByText("拖拽区"));
    const restore = await screen.findByRole("menuitem", { name: "还原" });
    const minimizeItem = screen.getByRole("menuitem", { name: "最小化" });

    expect(restore).toHaveFocus();
    fireEvent.keyDown(restore, { key: "ArrowDown" });
    expect(minimizeItem).toHaveFocus();
    fireEvent.keyDown(minimizeItem, { key: "Escape" });
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(returnFocus).toHaveFocus();
  });
});

function dispatchContextMenu(target: Element): MouseEvent {
  const event = new MouseEvent("contextmenu", {
    bubbles: true,
    cancelable: true,
    clientX: 40,
    clientY: 30,
  });
  fireEvent(target, event);
  return event;
}
