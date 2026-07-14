import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { PendingInteraction } from "../appServer";
import type { ServerRequest } from "../protocol/generated";
import { ApprovalPanel } from "./ApprovalPanel";

function pending(request: ServerRequest, responding = false): PendingInteraction {
  return { key: "number:1", request, responding };
}

function renderPanel(request: ServerRequest, additional: readonly PendingInteraction[] = []) {
  const onRespond = vi.fn(() => true);
  const onOpenLink = vi.fn();
  render(
    <ApprovalPanel
      onOpenLink={onOpenLink}
      onRespond={onRespond}
      pending={[pending(request), ...additional]}
      resolvedElsewhereCount={0}
    />,
  );
  return { onOpenLink, onRespond };
}

describe("ApprovalPanel", () => {
  it("展示命令上下文并提交一次性决定", () => {
    const request = {
      id: 1,
      method: "item/commandExecution/requestApproval",
      params: {
        availableDecisions: ["accept", "acceptForSession", "decline"],
        command: "pnpm test",
        cwd: "/workspace/project",
        itemId: "item-1",
        reason: "需要运行测试",
        startedAtMs: 1,
        threadId: "thread-1",
        turnId: "turn-1",
      },
    } as ServerRequest;
    const other = pending({ ...request, id: 2 } as ServerRequest);
    const { onRespond } = renderPanel(request, [other]);

    expect(screen.getByText("当前请求后还有 1 项")).toBeVisible();
    expect(screen.getByText("pnpm test")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "允许一次" }));
    expect(onRespond).toHaveBeenCalledWith("number:1", { decision: "accept" });
  });

  it("长期授权需要二次确认", () => {
    const request = {
      id: 1,
      method: "item/fileChange/requestApproval",
      params: {
        grantRoot: "/workspace/project",
        itemId: "item-1",
        startedAtMs: 1,
        threadId: "thread-1",
        turnId: "turn-1",
      },
    } as ServerRequest;
    const { onRespond } = renderPanel(request);

    fireEvent.click(screen.getByRole("button", { name: "本次会话允许" }));
    expect(screen.getByRole("alertdialog", { name: "确认长期授权" })).toBeVisible();
    expect(onRespond).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "确认授权" }));
    expect(onRespond).toHaveBeenCalledWith("number:1", { decision: "acceptForSession" });
  });

  it("收集结构化用户回答", () => {
    const request = {
      id: 1,
      method: "item/tool/requestUserInput",
      params: {
        itemId: "item-1",
        questions: [{
          header: "方案",
          id: "choice",
          options: [
            { description: "继续当前实现", label: "继续" },
            { description: "停止当前实现", label: "停止" },
          ],
          question: "下一步怎么做",
        }],
        threadId: "thread-1",
        turnId: "turn-1",
      },
    } as ServerRequest;
    const { onRespond } = renderPanel(request);

    fireEvent.click(screen.getByRole("radio", { name: /继续/u }));
    fireEvent.click(screen.getByRole("button", { name: "提交回答" }));
    expect(onRespond).toHaveBeenCalledWith("number:1", {
      answers: { choice: { answers: ["继续"] } },
    });
  });

  it("MCP 网页请求沿用统一链接入口", () => {
    const request = {
      id: 1,
      method: "mcpServer/elicitation/request",
      params: {
        elicitationId: "elicit-1",
        message: "请在网页中完成认证",
        mode: "url",
        serverName: "example-mcp",
        threadId: "thread-1",
        url: "https://example.com/auth",
      },
    } as ServerRequest;
    const { onOpenLink } = renderPanel(request);

    fireEvent.click(screen.getByRole("button", { name: "查看链接" }));
    expect(onOpenLink).toHaveBeenCalledWith("https://example.com/auth");
  });
});
