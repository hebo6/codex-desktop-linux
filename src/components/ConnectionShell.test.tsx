import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ConnectionShell } from "./ConnectionShell";

describe("ConnectionShell", () => {
  it("以可访问状态展示初始化进度", () => {
    render(<ConnectionShell phase="initializing" />);

    const status = screen.getByRole("status");
    expect(status.textContent).toContain("正在初始化 Codex");
    expect(status.textContent).toContain("初始化 app-server");
    expect(status.textContent).toContain("进行中");
    expect(screen.getByRole("button", { name: "新建任务" })).toHaveProperty(
      "disabled",
      true,
    );
  });

  it("支持切换窄窗口侧栏并处理连接错误", () => {
    const onRetry = vi.fn();
    render(
      <ConnectionShell
        detail="连接被服务器拒绝"
        onRetry={onRetry}
        phase="error"
      />,
    );

    expect(screen.getByRole("alert").textContent).toContain("连接被服务器拒绝");

    const menuButton = screen.getByLabelText("打开侧栏");
    fireEvent.click(menuButton);
    expect(menuButton.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getAllByLabelText("关闭侧栏")).toHaveLength(2);

    fireEvent.click(screen.getByRole("button", { name: "重试连接" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("展示自动重连倒计时并允许立即重试或停止", () => {
    const onRetry = vi.fn();
    const onStopReconnect = vi.fn();
    render(
      <ConnectionShell
        onRetry={onRetry}
        onStopReconnect={onStopReconnect}
        phase="error"
        reconnect={{ attempt: 2, nextAttemptAt: Date.now() + 5_000 }}
      />,
    );

    expect(screen.getByText(/秒后重连/u)).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "立即重试" }));
    fireEvent.click(screen.getByRole("button", { name: "停止重连" }));
    expect(onRetry).toHaveBeenCalledOnce();
    expect(onStopReconnect).toHaveBeenCalledOnce();
  });

  it("允许服务器控制器替换静态连接摘要", () => {
    render(
      <ConnectionShell
        phase="disconnected"
        serverControl={<button type="button">选择工作服务器</button>}
      />,
    );

    expect(
      screen.getByRole("button", { name: "选择工作服务器" }),
    ).toBeVisible();
    expect(screen.queryByText("当前连接")).not.toBeInTheDocument();
  });

  it("静态服务器栏在连接就绪时不展示状态圆点", () => {
    render(<ConnectionShell phase="ready" />);

    expect(
      screen.getByText("当前连接").parentElement?.parentElement
        ?.querySelector("[data-connection-indicator]"),
    ).toBeNull();
  });

  it("连接就绪后支持新建快捷键和项目分组切换", () => {
    const onNewTask = vi.fn();
    const onRefreshThreads = vi.fn();
    const onSearchThreads = vi.fn();
    render(
      <ConnectionShell
        onNewTask={onNewTask}
        onRefreshThreads={onRefreshThreads}
        onSearchThreads={onSearchThreads}
        phase="ready"
        threadListPhase="ready"
      />,
    );

    const groupButton = screen.getByRole("button", { name: "按项目分组" });
    const actionsButton = screen.getByRole("button", { name: "最近会话操作" });
    expect(screen.getByRole("button", { name: "新建任务" })).toHaveAttribute(
      "title",
      "新建任务（Ctrl+N）",
    );
    expect(groupButton).toHaveAttribute("title", "按项目分组");
    expect(groupButton.compareDocumentPosition(actionsButton)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    fireEvent.click(groupButton);
    expect(
      screen.getByRole("button", { name: "取消按项目分组" }),
    ).toHaveAttribute("aria-pressed", "true");

    fireEvent.click(actionsButton);
    fireEvent.click(screen.getByRole("menuitem", { name: "刷新会话" }));
    fireEvent.click(screen.getByRole("button", { name: "最近会话操作" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /搜索会话/u }));
    expect(onRefreshThreads).toHaveBeenCalledTimes(1);
    expect(onSearchThreads).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(window, { ctrlKey: true, key: "n" });
    expect(onNewTask).toHaveBeenCalledTimes(1);
  });

  it("支持键盘调整并提交侧栏宽度", () => {
    const onSidebarWidthChange = vi.fn();
    render(
      <ConnectionShell
        onSidebarWidthChange={onSidebarWidthChange}
        phase="ready"
        sidebarWidth={288}
      />,
    );

    const separator = screen.getByRole("separator", { name: "调整侧栏宽度" });
    fireEvent.keyDown(separator, { key: "ArrowRight" });
    expect(separator).toHaveAttribute("aria-valuenow", "296");
    expect(onSidebarWidthChange).toHaveBeenCalledWith(296);
  });

  it("支持手动隐藏和显示桌面侧栏", () => {
    render(<ConnectionShell phase="ready" />);

    const hideButton = screen.getByRole("button", { name: "隐藏侧栏" });
    const shell = hideButton.closest("[data-sidebar-collapsed]");
    expect(hideButton).toHaveAttribute("aria-expanded", "true");
    expect(shell).toHaveAttribute("data-sidebar-collapsed", "false");

    fireEvent.click(hideButton);
    const showButton = screen.getByRole("button", { name: "显示侧栏" });
    expect(showButton).toHaveAttribute("aria-expanded", "false");
    expect(shell).toHaveAttribute("data-sidebar-collapsed", "true");

    fireEvent.click(showButton);
    expect(screen.getByRole("button", { name: "隐藏侧栏" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    expect(shell).toHaveAttribute("data-sidebar-collapsed", "false");
  });

  it("断线时保留离线主内容并提供只读提示", () => {
    render(
      <ConnectionShell
        mainContent={<div>缓存消息</div>}
        offline
        offlineSyncedAt={1_000}
        phase="error"
      />,
    );

    expect(screen.getByText("缓存消息")).toBeVisible();
    expect(screen.getByText(/离线只读内容/u)).toBeVisible();
    expect(screen.getByText("离线只读")).toBeVisible();
  });
});
