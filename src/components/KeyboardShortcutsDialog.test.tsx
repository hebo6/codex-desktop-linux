import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { KeyboardShortcutsDialog } from "./KeyboardShortcutsDialog";

describe("KeyboardShortcutsDialog", () => {
  it("按分组展示快捷键并支持搜索功能和按键", () => {
    const { rerender } = render(
      <KeyboardShortcutsDialog onClose={vi.fn()} open />,
    );

    expect(screen.getByRole("dialog", { name: "键盘快捷键" })).toBeVisible();
    expect(screen.getByText("切换到上一个会话")).toBeVisible();
    expect(screen.getByText("Ctrl+PageUp")).toBeVisible();
    expect(screen.getByText("停止正在进行中的会话")).toBeVisible();
    expect(screen.getByText("打开项目选择器（仅新会话）")).toBeVisible();
    expect(screen.getByText("显示或隐藏侧边栏")).toBeVisible();

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
});
