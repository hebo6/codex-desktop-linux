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
  const onNew = vi.fn();
  const rendered = render(
    <ThreadTabs
      activeTabId={TAB.id}
      onActivate={onActivate}
      onClose={onClose}
      onNew={onNew}
      tabs={tabs}
    />,
  );
  return {
    onActivate,
    onClose,
    onNew,
    rerenderTabs(nextTabs: readonly ThreadTabView[]) {
      rendered.rerender(
        <ThreadTabs
          activeTabId={TAB.id}
          onActivate={onActivate}
          onClose={onClose}
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
});
