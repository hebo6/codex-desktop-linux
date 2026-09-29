import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { KeyboardShortcutsDialog } from "./KeyboardShortcutsDialog";

describe("KeyboardShortcutsDialog", () => {
  it("按分组展示快捷键并支持搜索功能和按键", () => {
    const { rerender } = render(
      <KeyboardShortcutsDialog onClose={vi.fn()} open />,
    );

    expect(screen.getByRole("dialog", { name: "键盘快捷键" })).toBeVisible();
    expect(screen.getByText("切换到上一个标签")).toBeVisible();
    expect(screen.getByText("Ctrl+PageUp")).toBeVisible();
    expect(screen.getByText("停止正在进行中的会话")).toBeVisible();
    expect(screen.getByText("发送或追加")).toBeVisible();
    expect(screen.getByText("排队发送（仅运行中）")).toBeVisible();
    expect(screen.getByText("Ctrl+Enter")).toBeVisible();
    expect(screen.getByText("编辑队尾消息（输入框为空时）")).toBeVisible();
    expect(screen.getByText("Alt+↑")).toBeVisible();
    expect(screen.getByText("Shift+Enter")).toBeVisible();
    expect(screen.getByText("打开协议检查器")).toBeVisible();
    expect(screen.getByText("Ctrl+Shift+D")).toBeVisible();
    expect(screen.getByText("打开项目选择器（仅新会话）")).toBeVisible();
    expect(screen.getByText("显示或隐藏侧边栏")).toBeVisible();
    expect(screen.getByText("显示或隐藏限额详情")).toBeVisible();
    expect(screen.getByText("Alt+L")).toBeVisible();
    expect(screen.getByText("关闭当前窗口")).toBeVisible();
    expect(screen.getByText("Ctrl+Shift+W")).toBeVisible();
    expect(screen.getByText("退出程序")).toBeVisible();
    expect(screen.getByText("Ctrl+Q")).toBeVisible();

    fireEvent.change(screen.getByRole("searchbox", { name: "搜索键盘快捷键" }), {
      target: { value: "F6" },
    });
    expect(screen.getByText("在输入框与消息区之间切换焦点")).toBeVisible();
    expect(screen.getByText("F6")).toBeVisible();

    fireEvent.change(screen.getByRole("searchbox", { name: "搜索键盘快捷键" }), {
      target: { value: "Ctrl+O" },
    });
    expect(screen.getByText("打开项目选择器（仅新会话）")).toBeVisible();
    expect(screen.queryByText("切换到上一个会话")).not.toBeInTheDocument();

    rerender(<KeyboardShortcutsDialog onClose={vi.fn()} open={false} />);
    expect(screen.queryByRole("dialog", { name: "键盘快捷键" })).not.toBeInTheDocument();
  });

  it("按 Esc 关闭并将焦点还给原控件", () => {
    const onClose = vi.fn();
    const trigger = document.createElement("button");
    document.body.append(trigger);
    trigger.focus();
    const { rerender } = render(
      <KeyboardShortcutsDialog onClose={onClose} open />,
    );

    expect(screen.getByRole("searchbox", { name: "搜索键盘快捷键" })).toHaveFocus();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();

    rerender(<KeyboardShortcutsDialog onClose={onClose} open={false} />);
    expect(trigger).toHaveFocus();
    trigger.remove();
  });

  it.each(["已处理", "输入法合成", "长按重复"])("%s的 Esc 不关闭弹窗", (reason) => {
    const onClose = vi.fn();
    render(<KeyboardShortcutsDialog onClose={onClose} open />);
    const event = new KeyboardEvent("keydown", {
      key: "Escape", bubbles: true, cancelable: true,
      isComposing: reason === "输入法合成", repeat: reason === "长按重复",
    });
    if (reason === "已处理") event.preventDefault();

    fireEvent(screen.getByRole("searchbox"), event);

    expect(onClose).not.toHaveBeenCalled();
  });

  it.each([{ ctrlKey: true }, { altKey: true }, { metaKey: true }])("焦点循环不抢占带修饰键的 Tab：%j", (modifiers) => {
    render(<KeyboardShortcutsDialog onClose={vi.fn()} open />);
    const list = screen.getByRole("region", { name: "快捷键列表" });
    list.focus();

    expect(fireEvent.keyDown(list, { key: "Tab", ...modifiers })).toBe(true);
    expect(list).toHaveFocus();

    fireEvent.keyDown(list, { key: "Tab" });
    expect(screen.getByRole("button", { name: "关闭键盘快捷键" })).toHaveFocus();
  });
});
