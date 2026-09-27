import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRef } from "react";
import { describe, expect, it, vi } from "vitest";

import type { ThreadSummary } from "../app/useServerThreads";
import { ThreadSearch } from "./ThreadSearch";

const firstThread = {
  cliVersion: "1.0.0",
  createdAt: 1,
  cwd: "/workspace/app",
  ephemeral: false,
  id: "one",
  modelProvider: "openai",
  name: "实现设置",
  preview: "设置",
  projectId: null,
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
    preview: "代理连接失败",
    sessionId: "session-two",
    updatedAt: 3,
  },
];

function renderSearch(onOpenThread = vi.fn(), onClose = vi.fn()) {
  const props = {
    currentThreadId: "one",
    inputRef: createRef<HTMLInputElement>(),
    onClose,
    onOpenThread,
    threads,
  };
  return { ...render(<ThreadSearch {...props} />), props };
}

describe("ThreadSearch", () => {
  it.each(["代理测试", "NETWORK", "连接失败"])("支持按标题、目录和预览过滤：%s", (query) => {
    const onOpenThread = vi.fn();
    renderSearch(onOpenThread);
    const input = screen.getByRole("combobox", { name: "搜索会话" });
    expect(input).toHaveFocus();
    fireEvent.change(input, { target: { value: query } });
    expect(screen.getByRole("option", { name: /代理测试/u })).toBeVisible();
    expect(screen.getAllByRole("option")).toHaveLength(1);
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onOpenThread).toHaveBeenCalledWith("two");
  });

  it("方向键循环选择并滚动到结果，列表缩短后仍可打开有效会话", () => {
    const { rerender, props } = renderSearch();
    const input = screen.getByRole("combobox");
    fireEvent.keyDown(input, { key: "ArrowUp" });
    const second = screen.getByRole("option", { name: /代理测试/u });
    expect(second).toHaveAttribute("aria-selected", "true");
    expect(input).toHaveAttribute("aria-activedescendant", second.id);
    expect(second.scrollIntoView).toHaveBeenCalledWith({ block: "nearest" });
    rerender(<ThreadSearch {...props} threads={[firstThread]} />);
    fireEvent.keyDown(input, { key: "Enter" });
    expect(props.onOpenThread).toHaveBeenCalledWith("one");
  });

  it("无匹配时显示空态，输入法确认和空结果不打开会话", () => {
    const { props } = renderSearch();
    const input = screen.getByRole("combobox");
    fireEvent.keyDown(input, { key: "Enter", isComposing: true });
    fireEvent.change(input, { target: { value: "没有这个会话" } });
    expect(screen.getByRole("status")).toHaveTextContent("没有匹配的会话");
    expect(input).not.toHaveAttribute("aria-activedescendant");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(props.onOpenThread).not.toHaveBeenCalled();
  });

  it("Tab 可离开搜索，区域外按键不选择会话，Esc 只由搜索区域处理", async () => {
    const user = userEvent.setup();
    const onOpenThread = vi.fn();
    const onClose = vi.fn();
    const onKeyDown = vi.fn();
    render(<div onKeyDown={onKeyDown}>
      <ThreadSearch currentThreadId="one" inputRef={createRef()} onClose={onClose} onOpenThread={onOpenThread} threads={threads} />
      <textarea aria-label="任务输入" />
    </div>);
    const input = screen.getByRole("combobox");
    await user.tab();
    expect(screen.getByRole("button", { name: "关闭会话搜索" })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole("textbox", { name: "任务输入" })).toHaveFocus();
    await user.keyboard("{ArrowDown}{Enter}");
    expect(onOpenThread).not.toHaveBeenCalled();
    expect(screen.getAllByRole("option")[0]).toHaveAttribute("aria-selected", "true");
    onKeyDown.mockClear();
    expect(fireEvent.keyDown(input, { key: "Escape", isComposing: true })).toBe(true);
    expect(onClose).not.toHaveBeenCalled();
    expect(onKeyDown).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();
    expect(onKeyDown).not.toHaveBeenCalled();
  });
});
