import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { ThreadSummary } from "../app/useServerThreads";
import { ThreadDeleteDialog } from "./ThreadDeleteDialog";

const THREAD = {
  cliVersion: "1.0.0",
  createdAt: 100,
  cwd: "/workspace/project",
  ephemeral: false,
  id: "thread-1",
  modelProvider: "openai",
  name: "待删除会话",
  preview: "预览",
  sessionId: "session-1",
  source: "appServer",
  status: { type: "idle" },
  turns: [],
  updatedAt: 200,
} satisfies ThreadSummary;

describe("ThreadDeleteDialog", () => {
  it("展示会话、服务器和不可恢复说明后确认删除", () => {
    const onConfirm = vi.fn();
    render(
      <ThreadDeleteDialog
        deleting={false}
        error={null}
        onCancel={vi.fn()}
        onConfirm={onConfirm}
        serverName="本机开发"
        thread={THREAD}
      />,
    );

    const dialog = screen.getByRole("dialog", { name: "删除会话？" });
    expect(dialog.textContent).toContain("待删除会话");
    expect(dialog.textContent).toContain("本机开发");
    expect(dialog.textContent).toContain("不可恢复");
    fireEvent.click(screen.getByRole("button", { name: "永久删除" }));
    expect(onConfirm).toHaveBeenCalledWith(THREAD.id);
  });

  it("删除中锁定操作并显示稳定错误", () => {
    render(
      <ThreadDeleteDialog
        deleting
        error="无法删除会话"
        onCancel={vi.fn()}
        onConfirm={vi.fn()}
        serverName="远程开发"
        thread={THREAD}
      />,
    );

    expect(screen.getByRole("alert")).toHaveTextContent("无法删除会话");
    expect(screen.getByRole("button", { name: "取消" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "正在删除" })).toBeDisabled();
  });
});
