import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ServerEventStore } from "../appServer/serverEventState";
import type { ServerNotification } from "../protocol/generated";
import { ServerActivityPanel } from "./ServerActivityPanel";

function consume(store: ServerEventStore, notification: ServerNotification) {
  act(() => {
    store.consume(notification);
    vi.advanceTimersByTime(80);
  });
}

function openPanel() {
  fireEvent.click(screen.getByRole("button", { name: /^运行状态/u }));
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("ServerActivityPanel", () => {
  it("高频通知先消费到存储，再合并为一次界面刷新", () => {
    vi.useFakeTimers();
    const store = new ServerEventStore();
    render(<ServerActivityPanel store={store} threadId="thread-1" />);
    act(() => {
      for (let index = 0; index < 20; index += 1) store.consume({ method: "warning", params: { message: `提醒 ${index}` } });
      vi.advanceTimersByTime(79);
    });
    expect(store.getSnapshot().records).toHaveLength(20);
    expect(screen.queryByRole("button", { name: /^运行状态/u })).not.toBeInTheDocument();
    act(() => vi.advanceTimersByTime(1));
    expect(screen.getByRole("button", { name: "运行状态 · 20 项需注意" })).toBeVisible();
  });

  it("折叠时继续合并事件，展开后隔离会话与全局消息", () => {
    vi.useFakeTimers();
    const store = new ServerEventStore();
    render(<ServerActivityPanel store={store} threadId="thread-1" />);
    consume(store, { method: "warning", params: { message: "全局连接提醒" } });
    consume(store, { method: "warning", params: { message: "当前会话提醒", threadId: "thread-1" } });
    consume(store, { method: "warning", params: { message: "其他会话提醒", threadId: "thread-2" } });

    expect(screen.queryByText("当前会话提醒")).not.toBeInTheDocument();
    openPanel();
    expect(within(screen.getByRole("region", { name: "当前会话状态" })).getByText("当前会话提醒")).toBeVisible();
    expect(within(screen.getByRole("region", { name: "服务器全局状态" })).getByText("全局连接提醒")).toBeVisible();
    expect(screen.queryByText("其他会话提醒")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /^运行状态/u }));
    consume(store, { method: "warning", params: { message: "收起期间新提醒", threadId: "thread-1" } });
    openPanel();
    expect(screen.getByText("收起期间新提醒")).toBeVisible();
  });

  it("上下文和目标预算均以剩余量绘制", () => {
    const store = new ServerEventStore();
    const breakdown = { cachedInputTokens: 10, inputTokens: 150, outputTokens: 50, reasoningOutputTokens: 20, totalTokens: 200 };
    store.consume({ method: "thread/tokenUsage/updated", params: {
      threadId: "thread-1", turnId: "turn-1", tokenUsage: { last: breakdown, total: { ...breakdown, totalTokens: 2_000 }, modelContextWindow: 1_000 },
    } });
    store.consume({ method: "thread/goal/updated", params: {
      threadId: "thread-1", goal: { threadId: "thread-1", objective: "完成协议接入", status: "active", tokenBudget: 500, tokensUsed: 100, timeUsedSeconds: 15, createdAt: 1, updatedAt: 2 },
    } });
    render(<ServerActivityPanel store={store} threadId="thread-1" />);
    expect(screen.getByRole("button", { name: "运行状态 · 上下文剩余 80%" })).toBeVisible();
    openPanel();
    expect(screen.getByRole("meter", { name: "上下文剩余" })).toHaveAttribute("aria-valuenow", "800");
    expect(screen.getByRole("meter", { name: "目标预算剩余" })).toHaveAttribute("aria-valuenow", "400");
    expect(screen.getByText("2,000")).toBeVisible();
  });

  it("详情按需挂载，汇总diff不会创建重复的正文记录", () => {
    const store = new ServerEventStore();
    store.consume({ method: "turn/diff/updated", params: { threadId: "thread-1", turnId: "turn-1", diff: "+new line" } });
    render(<ServerActivityPanel store={store} threadId="thread-1" />);
    openPanel();
    expect(screen.queryByText("+new line")).not.toBeInTheDocument();
    const summary = screen.getByText("本轮汇总变更 · turn-1");
    const details = summary.closest("details")!;
    details.open = true;
    fireEvent(details, new Event("toggle"));
    expect(screen.getByText("+new line")).toBeVisible();
  });

  it("展示客户端失败但不泄露其他会话请求", () => {
    render(<ServerActivityPanel store={null} threadId="thread-1" failures={[
      { key: "1", threadId: "thread-1", message: "客户端没有注册动态工具" },
      { key: "2", threadId: null, message: "外部认证刷新不可用" },
      { key: "3", threadId: "thread-2", message: "另一个会话的失败" },
    ]} />);
    openPanel();
    expect(screen.getByText("客户端没有注册动态工具")).toBeVisible();
    expect(screen.getByText("外部认证刷新不可用")).toBeVisible();
    expect(screen.queryByText("另一个会话的失败")).not.toBeInTheDocument();
  });

  it("元数据详情隐藏敏感字段，回合计划沿用原有面板", () => {
    const store = new ServerEventStore();
    store.consume({ method: "turn/moderationMetadata", params: {
      threadId: "thread-1", turnId: "turn-1", metadata: { category: "review", nested: { apiKey: "private-value", authorization: "Bearer private", password: "private-password" } },
    } });
    store.consume({ method: "turn/plan/updated", params: { threadId: "thread-1", turnId: "turn-1", plan: [{ step: "不应重复展示的步骤", status: "inProgress" }] } });
    render(<ServerActivityPanel store={store} threadId="thread-1" />);
    openPanel();
    const details = screen.getByText("查看详情").closest("details")!;
    details.open = true;
    fireEvent(details, new Event("toggle"));
    expect(screen.getByText(/"category": "review"/u)).toBeVisible();
    expect(document.body.textContent).not.toContain("private-value");
    expect(document.body.textContent).not.toContain("Bearer private");
    expect(document.body.textContent).not.toContain("private-password");
    expect(screen.queryByText("不应重复展示的步骤")).not.toBeInTheDocument();
  });

  it("显示队列中的非文本输入和最新项目名称及目录", () => {
    const store = new ServerEventStore();
    store.consume({ method: "thread/queue/changed", params: { threadId: "thread-1" } });
    store.hydrateQueue("thread-1", 1, [{ id: "queued-1", clientUserMessageId: "message-1", input: [
      { type: "text", text: "检查这些附件" }, { type: "image", url: "data:image/png;base64,private-data" },
      { type: "localAudio", path: "/tmp/recording.wav" }, { type: "skill", name: "review", path: "/workspace/review" },
    ] }]);
    store.hydrateProjects(0, [{ id: "project-1", name: "协议客户端", roots: [{ path: "/workspace/client" }], createdAt: 1, updatedAt: 1, position: 0, metadata: {} }]);
    render(<ServerActivityPanel store={store} threadId="thread-1" />);
    openPanel();
    expect(screen.getByText("待处理输入 · 1 条")).toBeVisible();
    const queueDetails = screen.getByText("待处理输入 1 · 文字、图片、音频、技能 review").closest("details")!;
    queueDetails.open = true;
    fireEvent(queueDetails, new Event("toggle"));
    expect(screen.getByText("检查这些附件")).toBeVisible();
    expect(screen.getByText("已附加图片")).toBeVisible();
    expect(screen.getByText("本地音频 · /tmp/recording.wav")).toBeVisible();
    expect(document.body.textContent).not.toContain("private-data");
    const projectDetails = screen.getByText("项目 · 1 个").closest("details")!;
    projectDetails.open = true;
    fireEvent(projectDetails, new Event("toggle"));
    expect(screen.getByText("协议客户端")).toBeVisible();
    expect(screen.getByText("/workspace/client")).toBeVisible();
  });

  it("无目标、空队列和空项目不会产生空面板", () => {
    const store = new ServerEventStore();
    store.hydrateGoal("thread-1", 0, null);
    store.consume({ method: "thread/queue/changed", params: { threadId: "thread-1" } });
    store.hydrateQueue("thread-1", 1, []);
    store.hydrateProjects(0, []);
    render(<ServerActivityPanel store={store} threadId="thread-1" />);
    expect(screen.queryByRole("region", { name: "运行状态" })).not.toBeInTheDocument();
  });

  it("只在用户操作后生成音频Blob并在切换会话时释放", () => {
    const createObjectURL = vi.fn((_blob: Blob) => "blob:audio-test");
    const revokeObjectURL = vi.fn();
    vi.stubGlobal("URL", class extends URL {
      static override createObjectURL = createObjectURL;
      static override revokeObjectURL = revokeObjectURL;
    });
    const store = new ServerEventStore();
    store.consume({ method: "thread/realtime/outputAudio/delta", params: {
      threadId: "thread-1", audio: { data: "AQACAA==", sampleRate: 24_000, numChannels: 1 },
    } });
    const { rerender } = render(<ServerActivityPanel store={store} threadId="thread-1" />);
    openPanel();
    expect(createObjectURL).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "加载已接收音频" }));
    const blob = createObjectURL.mock.calls[0]?.[0] as Blob | undefined;
    expect(blob?.type).toBe("audio/wav");
    expect(blob?.size).toBe(48);
    expect(screen.getByLabelText("已接收音频")).not.toHaveAttribute("autoplay");
    rerender(<ServerActivityPanel store={store} threadId="thread-2" />);
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:audio-test");
  });
});
