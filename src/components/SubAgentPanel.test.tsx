import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { SubAgentSummary } from "../app/subAgentState";
import { ComposerAccessoryPanel } from "./ComposerAccessoryPanel";
import { SubAgentPanel } from "./SubAgentPanel";

const AGENTS = [{
  name: "实现界面",
  role: "worker",
  status: "running",
  threadId: "agent-ui",
}, {
  name: "检查协议",
  role: null,
  status: "completed",
  threadId: "agent-protocol",
}] satisfies readonly SubAgentSummary[];

describe("SubAgentPanel", () => {
  it("折叠显示状态数量，展开显示名称、角色和各自状态", () => {
    render(<SubAgentPanel agents={AGENTS} error={null} onRetry={vi.fn()} />);

    const summary = screen.getByRole("button", {
      name: "子 agent · 1 个运行中 · 1 个已完成",
    });
    expect(summary).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("实现界面")).not.toBeInTheDocument();

    fireEvent.click(summary);

    expect(summary).toHaveAttribute("aria-expanded", "true");
    const rows = screen.getAllByRole("listitem");
    expect(within(rows[0]!).getByText("实现界面")).toBeVisible();
    expect(within(rows[0]!).getByText("worker")).toBeVisible();
    expect(within(rows[0]!).getByText("运行中")).toBeVisible();
    expect(within(rows[1]!).getByText("检查协议")).toBeVisible();
    expect(within(rows[1]!).getByText("已完成")).toBeVisible();

    fireEvent.click(summary);
    expect(summary).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByText("实现界面")).not.toBeVisible();
  });

  it("状态变化更新汇总和行内容，全部完成后保留面板和展开状态", () => {
    const onRetry = vi.fn();
    const { rerender } = render(
      <SubAgentPanel agents={AGENTS} error={null} onRetry={onRetry} />,
    );
    fireEvent.click(screen.getByRole("button", { name: /子 agent/ }));

    rerender(
      <SubAgentPanel
        agents={AGENTS.map((agent) => agent.threadId === "agent-ui"
          ? { ...agent, status: "waitingOnApproval" }
          : agent)}
        error={null}
        onRetry={onRetry}
      />,
    );

    expect(screen.getByRole("button", {
      name: "子 agent · 1 个等待审批 · 1 个已完成",
    })).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("等待审批")).toBeVisible();
    expect(screen.queryByText("运行中")).not.toBeInTheDocument();

    rerender(
      <SubAgentPanel
        agents={AGENTS.map((agent) => ({ ...agent, status: "completed" }))}
        error={null}
        onRetry={onRetry}
      />,
    );

    expect(screen.getByRole("button", {
      name: "子 agent · 2 个已完成",
    })).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("实现界面")).toBeVisible();
    expect(screen.getAllByText("已完成")).toHaveLength(2);
  });

  it("空闲和未加载分别展示，不误报为已完成", () => {
    render(
      <SubAgentPanel
        agents={[
          { ...AGENTS[0]!, status: "idle" },
          { ...AGENTS[1]!, status: "notLoaded" },
        ]}
        error={null}
        onRetry={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", {
      name: "子 agent · 1 个空闲 · 1 个未加载",
    }));
    expect(screen.getByText("空闲")).toBeVisible();
    expect(screen.getByText("未加载")).toBeVisible();
    expect(screen.queryByText("已完成")).not.toBeInTheDocument();
  });

  it("没有子 agent 且无错误时隐藏空附着容器", () => {
    render(
      <ComposerAccessoryPanel>
        <SubAgentPanel agents={[]} error={null} onRetry={vi.fn()} />
      </ComposerAccessoryPanel>,
    );

    expect(screen.queryByRole("region", { name: "子 agent" }))
      .not.toBeInTheDocument();
    expect(document.querySelector("[data-composer-accessory-panel]"))
      .not.toBeVisible();
  });

  it("读取状态失败时显示错误并允许重试", () => {
    const onRetry = vi.fn();
    const { rerender } = render(
      <SubAgentPanel
        agents={[]}
        error="无法读取子 agent 状态"
        onRetry={onRetry}
      />,
    );

    fireEvent.click(screen.getByRole("button", {
      name: "子 agent · 状态同步失败",
    }));
    expect(screen.getByRole("status"))
      .toHaveTextContent("无法读取子 agent 状态");
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(onRetry).toHaveBeenCalledOnce();

    rerender(<SubAgentPanel agents={AGENTS} error={null} onRetry={onRetry} />);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "重试" }))
      .not.toBeInTheDocument();
    expect(screen.getByText("实现界面")).toBeVisible();
  });
});
