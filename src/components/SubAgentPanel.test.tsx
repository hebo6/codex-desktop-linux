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
}] as const satisfies readonly SubAgentSummary[];

describe("SubAgentPanel", () => {
  it("折叠和展开均只展示未完成的子 agent", () => {
    render(<SubAgentPanel agents={AGENTS} error={null} onRetry={vi.fn()} />);

    const summary = screen.getByRole("button", {
      name: "子 agent · 1 个运行中",
    });
    expect(summary).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("实现界面")).not.toBeInTheDocument();

    fireEvent.click(summary);

    expect(summary).toHaveAttribute("aria-expanded", "true");
    const rows = screen.getAllByRole("listitem");
    expect(rows).toHaveLength(1);
    expect(within(rows[0]!).getByText("实现界面")).toBeVisible();
    expect(within(rows[0]!).getByText("worker")).toBeVisible();
    expect(within(rows[0]!).getByText("运行中")).toBeVisible();
    expect(screen.queryByText("检查协议")).not.toBeInTheDocument();
    expect(screen.queryByText("已完成")).not.toBeInTheDocument();

    fireEvent.click(summary);
    expect(summary).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByText("实现界面")).not.toBeVisible();
  });

  it("状态变化更新汇总，全部完成后隐藏，再次运行恢复展示", () => {
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
      name: "子 agent · 1 个等待审批",
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

    expect(screen.queryByRole("region", { name: "子 agent" })).not.toBeInTheDocument();
    expect(screen.queryByText("实现界面")).not.toBeInTheDocument();

    rerender(<SubAgentPanel agents={AGENTS} error={null} onRetry={onRetry} />);
    expect(screen.getByRole("button", { name: "子 agent · 1 个运行中" })).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("实现界面")).toBeVisible();
  });

  it("保留空闲状态，未加载条目不展示也不计入汇总", () => {
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
      name: "子 agent · 1 个空闲",
    }));
    expect(screen.getByText("空闲")).toBeVisible();
    expect(screen.queryByText("未加载")).not.toBeInTheDocument();
    expect(screen.queryByText("检查协议")).not.toBeInTheDocument();
    expect(screen.queryByText("已完成")).not.toBeInTheDocument();
  });

  it.each([
    { label: "空列表", agents: [] },
    { label: "全部未加载", agents: AGENTS.map((agent) => ({ ...agent, status: "notLoaded" as const })) },
  ])("没有可展示的子 agent 且无错误时隐藏空附着容器（$label）", ({ agents }) => {
    render(
      <ComposerAccessoryPanel>
        <SubAgentPanel agents={agents} error={null} onRetry={vi.fn()} />
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
        agents={AGENTS.map((agent) => ({ ...agent, status: "notLoaded" }))}
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

  it("失败、中断及等待输入仍需展示", () => {
    render(<SubAgentPanel agents={[
      { ...AGENTS[0], status: "errored" },
      { ...AGENTS[1], status: "interrupted" },
      { ...AGENTS[0], threadId: "agent-input", status: "waitingOnUserInput" },
    ]} error={null} onRetry={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "子 agent · 1 个等待输入 · 1 个出错 · 1 个已中断" }));
    expect(screen.getByText("出错")).toBeVisible();
    expect(screen.getByText("已中断")).toBeVisible();
    expect(screen.getByText("等待输入")).toBeVisible();
  });
});
