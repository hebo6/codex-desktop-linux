import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ThreadTabs, type ThreadTabView } from "./ThreadTabs";

const TAB = {
  id: "tab-1",
  projectName: "codex-desktop-linux",
  projectPath: "/workspace/codex-desktop-linux",
  status: "running",
  title: "修复测试失败",
} satisfies ThreadTabView;

function renderTabs(tabs: readonly ThreadTabView[] = [TAB]) {
  const onActivate = vi.fn();
  const onClose = vi.fn();
  const onCloseOthers = vi.fn();
  const onCloseRight = vi.fn();
  const onNew = vi.fn();
  const rendered = render(
    <ThreadTabs
      activeTabId={TAB.id}
      onActivate={onActivate}
      onClose={onClose}
      onCloseOthers={onCloseOthers}
      onCloseRight={onCloseRight}
      onNew={onNew}
      tabs={tabs}
    />,
  );
  return {
    onActivate,
    onClose,
    onCloseOthers,
    onCloseRight,
    onNew,
    rerenderTabs(nextTabs: readonly ThreadTabView[]) {
      rendered.rerender(
        <ThreadTabs
          activeTabId={TAB.id}
          onActivate={onActivate}
          onClose={onClose}
          onCloseOthers={onCloseOthers}
          onCloseRight={onCloseRight}
          onNew={onNew}
          tabs={nextTabs}
        />,
      );
    },
  };
}

describe("ThreadTabs", () => {
  it("在标题下方显示项目名并通过提示展示完整路径", () => {
    renderTabs();

    const tab = screen.getByRole("tab");
    expect(tab).toHaveTextContent(/修复测试失败.*codex-desktop-linux/u);
    expect(tab).toHaveAttribute(
      "title",
      "修复测试失败\n/workspace/codex-desktop-linux",
    );
    expect(within(tab).getByRole("img", { name: "正在运行" }))
      .toHaveAttribute("data-status", "running");
  });

  it("复用侧边栏的审批、待回复和失败状态内容", () => {
    renderTabs([
      { ...TAB, id: "approval", status: "approval" },
      { ...TAB, id: "input", status: "input" },
      { ...TAB, id: "error", status: "error" },
    ]);

    expect(screen.getByRole("img", { name: "等待审批" })).toHaveTextContent("审批");
    expect(screen.getByRole("img", { name: "等待输入" })).toHaveTextContent("待回复");
    expect(screen.getByRole("img", { name: "会话失败" })).toHaveTextContent("失败");
  });

  it("使用静态圆圈勾选图标提示完成结果等待查看", () => {
    renderTabs([{ ...TAB, status: "resultReady" }]);

    const indicator = screen.getByRole("img", {
      name: "任务已完成，等待查看",
    });
    expect(indicator).toHaveAttribute("data-status", "resultReady");
    expect(indicator).toHaveAttribute("title", "任务已完成，等待查看");
    expect(indicator.querySelector("circle")).not.toBeNull();
  });

  it("查看完成结果后淡出提示图标", async () => {
    const { rerenderTabs } = renderTabs([{ ...TAB, status: "resultReady" }]);
    const viewedTab = {
      id: TAB.id,
      projectName: TAB.projectName,
      projectPath: TAB.projectPath,
      title: TAB.title,
    } satisfies ThreadTabView;

    rerenderTabs([viewedTab]);

    expect(
      screen.getByRole("img", { name: "任务已完成，等待查看" }),
    ).toHaveAttribute("data-dismissing", "true");
    await waitFor(() =>
      expect(
        screen.queryByRole("img", { name: "任务已完成，等待查看" }),
      ).not.toBeInTheDocument()
    );
  });

  it("保留激活、关闭和新建标签操作", () => {
    const { onActivate, onClose, onNew } = renderTabs();

    fireEvent.click(screen.getByRole("tab"));
    fireEvent.click(screen.getByRole("button", { name: "关闭“修复测试失败”" }));
    fireEvent.click(screen.getByRole("button", { name: "新建会话标签" }));

    expect(onActivate).toHaveBeenCalledWith(TAB.id);
    expect(onClose).toHaveBeenCalledWith(TAB.id);
    expect(onNew).toHaveBeenCalledOnce();
  });

  it("通过右键菜单关闭目标、其他或右侧标签", () => {
    const tabs = [
      TAB,
      { ...TAB, id: "tab-2", title: "第二个标签" },
      { ...TAB, id: "tab-3", title: "第三个标签" },
    ];
    const { onClose, onCloseOthers, onCloseRight } = renderTabs(tabs);
    const second = screen.getByRole("tab", { name: /第二个标签/u });

    fireEvent.contextMenu(second, { clientX: 120, clientY: 80 });
    expect(screen.getByRole("menu", { name: "标签“第二个标签”操作" }))
      .toBeVisible();
    fireEvent.click(screen.getByRole("menuitem", { name: /关闭标签/u }));
    expect(onClose).toHaveBeenCalledWith("tab-2");

    fireEvent.contextMenu(second, { clientX: 120, clientY: 80 });
    fireEvent.click(screen.getByRole("menuitem", { name: "关闭其他标签页" }));
    expect(onCloseOthers).toHaveBeenCalledWith("tab-2");

    fireEvent.contextMenu(second, { clientX: 120, clientY: 80 });
    fireEvent.click(screen.getByRole("menuitem", { name: "关闭右侧标签页" }));
    expect(onCloseRight).toHaveBeenCalledWith("tab-2");
  });

  it("支持键盘打开菜单、菜单导航和焦点恢复", () => {
    renderTabs([
      TAB,
      { ...TAB, id: "tab-2", title: "第二个标签" },
    ]);
    const first = screen.getByRole("tab", { name: /修复测试失败/u });

    first.focus();
    fireEvent.keyDown(first, { key: "F10", shiftKey: true });
    const close = screen.getByRole("menuitem", { name: /关闭标签/u });
    const closeOthers = screen.getByRole("menuitem", {
      name: "关闭其他标签页",
    });
    expect(close).toHaveFocus();
    fireEvent.keyDown(close, { key: "ArrowDown" });
    expect(closeOthers).toHaveFocus();
    fireEvent.keyDown(closeOthers, { key: "Escape" });
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(first).toHaveFocus();
  });

  it("没有可关闭目标时禁用对应批量操作", () => {
    renderTabs();
    fireEvent.contextMenu(screen.getByRole("tab"));

    expect(screen.getByRole("menuitem", { name: "关闭其他标签页" }))
      .toBeDisabled();
    expect(screen.getByRole("menuitem", { name: "关闭右侧标签页" }))
      .toBeDisabled();
  });
});
