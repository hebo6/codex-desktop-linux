import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { SubAgentSummary } from "../app/subAgentState";
import { useSubAgentDetails, type SubAgentDetailsClient } from "../app/useSubAgentDetails";
import type { Turn } from "../protocol/generated/types/ThreadTurnsListResponse";
import { ComposerAccessoryPanel } from "./ComposerAccessoryPanel";
import { SubAgentPanel } from "./SubAgentPanel";

vi.mock("../app/useSubAgentDetails", () => ({ useSubAgentDetails: vi.fn() }));

const detailsMock = vi.mocked(useSubAgentDetails);
const CLIENT: SubAgentDetailsClient = { listLatestThreadTurn: vi.fn() };
const TURN: Turn = {
  id: "turn-1",
  status: "inProgress",
  items: [{ id: "message-1", type: "agentMessage", phase: "commentary", text: "正在检查代码" }],
};

beforeEach(() => {
  detailsMock.mockReset().mockReturnValue({
    turn: null,
    loading: false,
    error: null,
    refresh: vi.fn(),
  });
});

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
    render(<SubAgentPanel client={null} agents={AGENTS} error={null} onRetry={vi.fn()} />);

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
      <SubAgentPanel client={null} agents={AGENTS} error={null} onRetry={onRetry} />,
    );
    fireEvent.click(screen.getByRole("button", { name: /子 agent/ }));

    rerender(
      <SubAgentPanel client={null}
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
      <SubAgentPanel client={null}
        agents={AGENTS.map((agent) => ({ ...agent, status: "completed" }))}
        error={null}
        onRetry={onRetry}
      />,
    );

    expect(screen.queryByRole("region", { name: "子 agent" })).not.toBeInTheDocument();
    expect(screen.queryByText("实现界面")).not.toBeInTheDocument();

    rerender(<SubAgentPanel client={null} agents={AGENTS} error={null} onRetry={onRetry} />);
    expect(screen.getByRole("button", { name: "子 agent · 1 个运行中" })).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("实现界面")).toBeVisible();
  });

  it("保留空闲状态，未加载条目不展示也不计入汇总", () => {
    render(
      <SubAgentPanel client={null}
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
        <SubAgentPanel client={null} agents={agents} error={null} onRetry={vi.fn()} />
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
      <SubAgentPanel client={null}
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

    rerender(<SubAgentPanel client={null} agents={AGENTS} error={null} onRetry={onRetry} />);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "重试" }))
      .not.toBeInTheDocument();
    expect(screen.getByText("实现界面")).toBeVisible();
  });

  it("失败、中断及等待输入仍需展示", () => {
    render(<SubAgentPanel client={null} agents={[
      { ...AGENTS[0], status: "errored" },
      { ...AGENTS[1], status: "interrupted" },
      { ...AGENTS[0], threadId: "agent-input", status: "waitingOnUserInput" },
    ]} error={null} onRetry={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "子 agent · 1 个等待输入 · 1 个出错 · 1 个已中断" }));
    expect(screen.getByText("出错")).toBeVisible();
    expect(screen.getByText("已中断")).toBeVisible();
    expect(screen.getByText("等待输入")).toBeVisible();
  });

  it("逐行按需读取，收起行卸载详情，收起外层面板只停用读取并保留动画所需高度", () => {
    const { rerender } = render(
      <SubAgentPanel agents={AGENTS} client={CLIENT} error={null} onRetry={vi.fn()} />,
    );
    expect(detailsMock).not.toHaveBeenCalled();
    const summary = screen.getByRole("button", { name: /^子 agent/ });
    fireEvent.click(summary);
    expect(detailsMock).not.toHaveBeenCalled();

    const row = screen.getByRole("button", { name: "实现界面 worker 运行中" });
    expect(row).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(row);
    expect(row).toHaveAttribute("aria-expanded", "true");
    expect(detailsMock).toHaveBeenLastCalledWith(CLIENT, "agent-ui", "running", true);
    expect(screen.getByRole("region", { name: "实现界面详情" })).toBeVisible();

    fireEvent.click(row);
    expect(screen.queryByRole("region", { name: "实现界面详情", hidden: true }))
      .not.toBeInTheDocument();
    detailsMock.mockClear();
    rerender(<SubAgentPanel agents={AGENTS} client={CLIENT} error={null} onRetry={vi.fn()} />);
    expect(detailsMock).not.toHaveBeenCalled();

    fireEvent.click(row);
    const detail = screen.getByRole("region", { name: "实现界面详情" });
    fireEvent.click(summary);
    expect(detail).toBeInTheDocument();
    expect(detail).not.toBeVisible();
    expect(detailsMock).toHaveBeenLastCalledWith(CLIENT, "agent-ui", "running", false);

    fireEvent.click(summary);
    expect(detailsMock).toHaveBeenLastCalledWith(CLIENT, "agent-ui", "running", true);
    expect(screen.getByRole("region", { name: "实现界面详情" })).toBeVisible();
  });

  it("键盘可以展开和收起 agent 详情", async () => {
    const user = userEvent.setup();
    render(<SubAgentPanel agents={AGENTS} client={CLIENT} error={null} onRetry={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /^子 agent/ }));
    const row = screen.getByRole("button", { name: "实现界面 worker 运行中" });
    row.focus();

    await user.keyboard("{Enter}");
    expect(screen.getByRole("region", { name: "实现界面详情" })).toBeVisible();
    await user.keyboard(" ");
    expect(screen.queryByRole("region", { name: "实现界面详情" })).not.toBeInTheDocument();
    expect(row).toHaveFocus();
  });

  it("显示最新最终结果与服务端耗时，输出保留全文且不执行 HTML", () => {
    const text = "第一行\n<img src=x onerror=alert(1)>\n" + "完整结果".repeat(2_000);
    const refresh = vi.fn();
    detailsMock.mockReturnValue({
      turn: {
        ...TURN,
        status: "completed",
        durationMs: 62_000,
        items: [...TURN.items, { id: "final", type: "agentMessage", phase: "final_answer", text }],
      },
      loading: false,
      error: null,
      refresh,
    });
    renderAndExpandDetails();

    expect(screen.getByText("最近回合 · 耗时 1 分 2 秒")).toBeVisible();
    const output = screen.getByRole("region", { name: "最终结果" });
    expect(output.textContent).toBe(text);
    expect(output.querySelector("img")).toBeNull();
    expect(screen.queryByText("正在检查代码")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "刷新" }));
    expect(refresh).toHaveBeenCalledOnce();
  });

  it("运行中显示最近输出，未返回耗时时不伪造数值", () => {
    detailsMock.mockReturnValue({ turn: TURN, loading: false, error: null, refresh: vi.fn() });
    renderAndExpandDetails();

    expect(screen.getByText("最近回合 · 正在运行")).toBeVisible();
    expect(screen.getByRole("region", { name: "最近输出" }))
      .toHaveTextContent("正在检查代码");
    expect(screen.queryByText(/耗时/)).not.toBeInTheDocument();
    expect(screen.queryByText("最终结果")).not.toBeInTheDocument();
  });

  it.each([
    { label: "无回合", turn: null, expected: "暂无回合" },
    { label: "回合无输出", turn: { ...TURN, status: "interrupted" as const, items: [] }, expected: "暂无输出" },
  ])("明确展示空状态：$label", ({ turn, expected }) => {
    detailsMock.mockReturnValue({ turn, loading: false, error: null, refresh: vi.fn() });
    renderAndExpandDetails();

    expect(screen.getByText(expected)).toBeVisible();
    expect(screen.getByRole("button", { name: "刷新" })).toBeEnabled();
    expect(screen.queryByText(/耗时/)).not.toBeInTheDocument();
  });

  it("读取中展示进度并禁用重复读取", () => {
    detailsMock.mockReturnValue({ turn: null, loading: true, error: null, refresh: vi.fn() });
    renderAndExpandDetails();

    expect(screen.getByRole("region", { name: "实现界面详情" })).toHaveAttribute("aria-busy", "true");
    expect(screen.getByText("正在读取最近回合…")).toBeVisible();
    expect(screen.getByRole("button", { name: "读取中…" })).toBeDisabled();
    expect(screen.queryByText("暂无回合")).not.toBeInTheDocument();
  });

  it("详情读取失败保留已知输出，可重试且不混淆为执行失败", () => {
    const refresh = vi.fn();
    detailsMock.mockReturnValue({ turn: TURN, loading: false, error: "无法读取子 agent 详情", refresh });
    renderAndExpandDetails();

    expect(screen.getByRole("status")).toHaveTextContent("无法读取子 agent 详情");
    expect(screen.getByRole("region", { name: "最近输出" })).toHaveTextContent("正在检查代码");
    expect(screen.queryByText("执行失败")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(refresh).toHaveBeenCalledOnce();
  });

  it("显示执行失败原因及附加详情", () => {
    detailsMock.mockReturnValue({
      turn: {
        ...TURN,
        status: "failed",
        durationMs: 480,
        error: { message: "服务拒绝请求", additionalDetails: "第一条说明\n第二条说明" },
      },
      loading: false,
      error: null,
      refresh: vi.fn(),
    });
    renderAndExpandDetails();

    expect(screen.getByText("执行失败")).toBeVisible();
    expect(screen.getByText("服务拒绝请求")).toBeVisible();
    expect(screen.getByText("第一条说明 第二条说明").textContent).toBe("第一条说明\n第二条说明");
    expect(screen.getByText("最近回合 · 耗时 480 毫秒")).toBeVisible();
    expect(screen.queryByText("无法读取子 agent 详情")).not.toBeInTheDocument();
  });

  it("断开连接时提示连接后查看，不误报为空回合", () => {
    renderAndExpandDetails(null);

    expect(screen.getByText("连接后可查看详情")).toBeVisible();
    expect(screen.getByRole("button", { name: "刷新" })).toBeDisabled();
    expect(screen.queryByText("暂无回合")).not.toBeInTheDocument();
  });
});

function renderAndExpandDetails(client: SubAgentDetailsClient | null = CLIENT) {
  render(<SubAgentPanel agents={AGENTS} client={client} error={null} onRetry={vi.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: /^子 agent/ }));
  fireEvent.click(screen.getByRole("button", { name: "实现界面 worker 运行中" }));
}
