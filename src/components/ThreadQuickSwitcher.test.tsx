import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { ThreadSummary } from "../app/useServerThreads";
import { ThreadQuickSwitcher } from "./ThreadQuickSwitcher";

const firstThread = {
  cliVersion: "1.0.0",
  createdAt: 1,
  cwd: "/workspace/app",
  ephemeral: false,
  id: "one",
  modelProvider: "openai",
  name: "实现设置",
  preview: "设置",
  sessionId: "session-one",
  source: "appServer",
  status: { type: "idle" },
  turns: [],
  updatedAt: 2,
} satisfies ThreadSummary;

const threads: ThreadSummary[] = [
  firstThread,
  {
    ...firstThread,
    cwd: "/workspace/network",
    id: "two",
    name: "代理测试",
    preview: "代理",
    sessionId: "session-two",
    updatedAt: 3,
  },
];

describe("ThreadQuickSwitcher", () => {
  it("支持过滤和键盘打开会话", () => {
    const onOpenThread = vi.fn();
    const onClose = vi.fn();
    render(<ThreadQuickSwitcher currentThreadId="one" onClose={onClose} onOpenThread={onOpenThread} open threads={threads} />);
    fireEvent.change(screen.getByRole("textbox", { name: "搜索会话" }), { target: { value: "network" } });
    expect(screen.getByRole("option", { name: /代理测试/u })).toBeVisible();
    fireEvent.keyDown(window, { key: "Enter" });
    expect(onOpenThread).toHaveBeenCalledWith("two");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("将 Tab 焦点限制在快速切换浮层内", () => {
    render(
      <ThreadQuickSwitcher
        currentThreadId="one"
        onClose={vi.fn()}
        onOpenThread={vi.fn()}
        open
        threads={threads}
      />,
    );
    const input = screen.getByRole("textbox", { name: "搜索会话" });
    const options = screen.getAllByRole("option");
    options.at(-1)?.focus();
    fireEvent.keyDown(window, { key: "Tab" });
    expect(input).toHaveFocus();
    fireEvent.keyDown(window, { key: "Tab", shiftKey: true });
    expect(options.at(-1)).toHaveFocus();
  });
});
