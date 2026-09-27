import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SERVER_EVENT_LIMITS, ServerEventStore } from "../appServer/serverEventState";
import type { ThreadTurn } from "../app/useServerThreads";
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

const UPDATED_FILE_DIFF = "diff --git a/src/App.tsx b/src/App.tsx\nindex abc..def\n--- a/src/App.tsx\n+++ b/src/App.tsx\n@@ -1 +1 @@\n-old line\n+new line\n";
const DELETED_FILE_DIFF = "diff --git a/old.txt b/old.txt\ndeleted file mode 100644\nindex abc..000\n--- a/old.txt\n+++ /dev/null\n@@ -1 +0,0 @@\n-removed line\n";

const COMMAND_TURN: ThreadTurn = {
  id: "earlier-turn", status: "completed", itemsView: "full",
  items: [{
    type: "commandExecution", id: "command-1", command: "pnpm dev --host 127.0.0.1",
    cwd: "/workspace", commandActions: [], processId: "2557", status: "inProgress",
  }],
};

function terminalInput(store: ServerEventStore, stdin: string) {
  store.consume({ method: "item/commandExecution/terminalInteraction", params: {
    threadId: "thread-1", turnId: "later-turn", itemId: "command-1", processId: "2557", stdin,
  } });
}

function openDiffSummary() {
  const details = screen.getByText(/^本轮汇总变更/u).closest("details")!;
  details.open = true;
  fireEvent(details, new Event("toggle"));
  return details;
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("ServerActivityPanel", () => {
  it("跨回合关联具体命令，直接展示中断按键且不宣称命令已停止", () => {
    const store = new ServerEventStore();
    terminalInput(store, "\u0003");
    render(<ServerActivityPanel store={store} threadId="thread-1" turns={[COMMAND_TURN]} />);
    openPanel();
    expect(screen.getByLabelText("对应命令")).toHaveTextContent("pnpm dev --host 127.0.0.1");
    expect(screen.getByText("进程 2557")).toBeVisible();
    expect(screen.getByText("已发送")).toBeVisible();
    expect(screen.getByLabelText("已发送的终端输入")).toHaveTextContent("⟦Ctrl+C：请求中断⟧");
    expect(document.body.textContent).not.toContain("\u0003");
    expect(screen.queryByText("已停止")).not.toBeInTheDocument();
  });

  it("命令未加载时不借用同进程号的其他命令，历史加载后自动显示对应命令", () => {
    const store = new ServerEventStore();
    terminalInput(store, "\u0003");
    const unrelatedTurn: ThreadTurn = { ...COMMAND_TURN, items: [{
      ...COMMAND_TURN.items[0]!, id: "other-command", command: "不应显示的命令",
    }] };
    const { rerender } = render(<ServerActivityPanel store={store} threadId="thread-1" turns={[unrelatedTurn]} />);
    openPanel();
    expect(screen.getByText("命令记录未加载")).toBeVisible();
    expect(screen.queryByLabelText("对应命令")).not.toBeInTheDocument();
    rerender(<ServerActivityPanel store={store} threadId="thread-1" turns={[COMMAND_TURN, unrelatedTurn]} />);
    expect(screen.queryByText("命令记录未加载")).not.toBeInTheDocument();
    expect(screen.getByLabelText("对应命令")).toHaveTextContent("pnpm dev --host 127.0.0.1");
    expect(screen.queryByText("不应显示的命令")).not.toBeInTheDocument();
  });

  it("按原顺序展示普通文字和按键，换行保持可读且不渲染控制字符", () => {
    const store = new ServerEventStore();
    terminalInput(store, "你好\tworld\r\n");
    terminalInput(store, "next\n\r\u0004\u001a\u001b\b\u007f\u0000\u009b");
    render(<ServerActivityPanel store={store} threadId="thread-1" turns={[COMMAND_TURN]} />);
    openPanel();
    expect(screen.getByLabelText("已发送的终端输入").textContent).toBe(
      "你好⟦Tab：制表⟧world⟦Enter：回车换行⟧\nnext⟦Enter：换行⟧\n⟦Enter：回车⟧"
      + "⟦Ctrl+D：结束输入⟧⟦Ctrl+Z：请求挂起⟧⟦Esc⟧⟦Backspace：退格⟧⟦Backspace：退格⟧⟦U+0000⟧⟦U+009B⟧",
    );
    expect(store.getSnapshot().records[0]?.text).toContain("你好\tworld\r\n");
  });

  it("等待输出的空轮询不显示为终端输入", () => {
    const store = new ServerEventStore();
    terminalInput(store, "");
    render(<ServerActivityPanel store={store} threadId="thread-1" turns={[COMMAND_TURN]} />);
    expect(screen.queryByRole("button", { name: /^运行状态/u })).not.toBeInTheDocument();
  });

  it("高频通知先消费到存储，再合并为一次界面刷新", () => {
    vi.useFakeTimers();
    const store = new ServerEventStore();
    render(<ServerActivityPanel store={store} threadId="thread-1" />);
    act(() => {
      for (let index = 0; index < 20; index += 1) store.consume({ method: "warning", params: { message: `提醒 ${index}`, threadId: "thread-1" } });
      vi.advanceTimersByTime(79);
    });
    expect(store.getSnapshot().records).toHaveLength(20);
    expect(screen.queryByRole("button", { name: /^运行状态/u })).not.toBeInTheDocument();
    act(() => vi.advanceTimersByTime(1));
    expect(screen.getByRole("button", { name: "运行状态 · 20 项需注意" })).toBeVisible();
  });

  it("折叠时继续合并事件，展示及提醒数量仅属于当前会话", () => {
    vi.useFakeTimers();
    const store = new ServerEventStore();
    const { rerender } = render(<ServerActivityPanel store={store} threadId="thread-1" />);
    consume(store, { method: "warning", params: { message: "全局连接提醒" } });
    consume(store, { method: "warning", params: { message: "当前会话提醒", threadId: "thread-1" } });
    consume(store, { method: "warning", params: { message: "其他会话提醒", threadId: "thread-2" } });

    expect(screen.queryByText("当前会话提醒")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "运行状态 · 1 项需注意" })).toBeVisible();
    openPanel();
    expect(within(screen.getByRole("region", { name: "当前会话状态" })).getByText("当前会话提醒")).toBeVisible();
    expect(screen.queryByRole("region", { name: "服务器全局状态" })).not.toBeInTheDocument();
    expect(screen.queryByText("全局连接提醒")).not.toBeInTheDocument();
    expect(screen.queryByText("其他会话提醒")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /^运行状态/u }));
    consume(store, { method: "warning", params: { message: "收起期间新提醒", threadId: "thread-1" } });
    openPanel();
    expect(screen.getByText("收起期间新提醒")).toBeVisible();
    expect(screen.getByRole("button", { name: "运行状态 · 2 项需注意" })).toBeVisible();

    rerender(<ServerActivityPanel store={store} threadId="thread-2" />);
    expect(screen.getByText("其他会话提醒")).toBeVisible();
    expect(screen.queryByText("当前会话提醒")).not.toBeInTheDocument();
    expect(screen.queryByText("收起期间新提醒")).not.toBeInTheDocument();
    expect(screen.queryByText("全局连接提醒")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "运行状态 · 1 项需注意" })).toBeVisible();

    rerender(<ServerActivityPanel store={store} threadId={null} />);
    expect(screen.queryByRole("button", { name: /^运行状态/u })).not.toBeInTheDocument();
  });

  it.each(["thread-1", null])("只有全局状态时不创建运行面板（当前会话：%s）", (threadId) => {
    const store = new ServerEventStore();
    store.consume({ method: "remoteControl/status/changed", params: { installationId: "installation-1", serverName: "server-1", status: "disabled" } });
    store.consume({ method: "warning", params: { message: "全局连接提醒" } });
    store.hydrateProjects(0, [{ id: "project-1", name: "协议客户端", roots: [{ path: "/workspace/client" }], createdAt: 1, updatedAt: 1, position: 0, metadata: {} }]);
    store.startProcess("process", "global-process");
    render(<ServerActivityPanel store={store} threadId={threadId} failures={[
      { key: "global-failure", threadId: null, message: "外部认证刷新不可用" },
    ]} />);

    expect(store.getSnapshot().records.some((record) => record.method === "remoteControl/status/changed")).toBe(true);
    expect(screen.queryByRole("button", { name: /^运行状态/u })).not.toBeInTheDocument();
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
    expect(screen.getByText("2K")).toBeVisible();
  });

  it.each(["complete", "cleared"] as const)("目标结束后隐藏卡片及收尾记录（%s），再次激活时恢复", (ending) => {
    vi.useFakeTimers();
    const store = new ServerEventStore();
    const goal = { threadId: "thread-1", objective: "完成协议接入", status: "active" as const, tokenBudget: 500, tokensUsed: 100, timeUsedSeconds: 15, createdAt: 1, updatedAt: 2 };
    store.consume({ method: "thread/goal/updated", params: { threadId: "thread-1", goal } });
    render(<ServerActivityPanel store={store} threadId="thread-1" />);
    openPanel();
    expect(screen.getByText("完成协议接入")).toBeVisible();

    consume(store, ending === "complete"
      ? { method: "thread/goal/updated", params: { threadId: "thread-1", goal: { ...goal, status: "complete" } } }
      : { method: "thread/goal/cleared", params: { threadId: "thread-1" } });
    expect(screen.queryByRole("button", { name: /^运行状态/u })).not.toBeInTheDocument();
    expect(screen.queryByText("会话目标已清除")).not.toBeInTheDocument();

    consume(store, { method: "thread/goal/updated", params: { threadId: "thread-1", goal } });
    expect(screen.getByText("完成协议接入")).toBeVisible();
  });

  it("正常完成的活动从面板移除，失败及告警继续展示", () => {
    vi.useFakeTimers();
    const store = new ServerEventStore();
    store.consume({ method: "mcpServer/startupStatus/updated", params: { threadId: "thread-1", name: "tools", status: "starting" } });
    render(<ServerActivityPanel store={store} threadId="thread-1" />);
    openPanel();
    expect(screen.getByText("MCP · tools")).toBeVisible();

    consume(store, { method: "mcpServer/startupStatus/updated", params: { threadId: "thread-1", name: "tools", status: "ready" } });
    expect(screen.queryByRole("button", { name: /^运行状态/u })).not.toBeInTheDocument();

    consume(store, { method: "mcpServer/startupStatus/updated", params: { threadId: "thread-1", name: "tools", status: "failed", error: "启动失败" } });
    consume(store, { method: "warning", params: { threadId: "thread-1", message: "需要检查配置" } });
    expect(screen.getByText("启动失败")).toBeVisible();
    expect(screen.getByText("需要检查配置")).toBeVisible();
    expect(screen.getByRole("button", { name: "运行状态 · 2 项需注意" })).toBeVisible();
  });

  it("没有输出的实时会话正常关闭后隐藏面板", () => {
    vi.useFakeTimers();
    const store = new ServerEventStore();
    store.consume({ method: "thread/realtime/started", params: { threadId: "thread-1", version: "v3", realtimeSessionId: "realtime-1" } });
    render(<ServerActivityPanel store={store} threadId="thread-1" />);
    expect(screen.getByRole("button", { name: /^运行状态/u })).toBeVisible();
    consume(store, { method: "thread/realtime/closed", params: { threadId: "thread-1", reason: "已结束" } });
    expect(screen.queryByRole("button", { name: /^运行状态/u })).not.toBeInTheDocument();
  });

  it("实时会话关闭后保留转写和音频内容，不再显示完成状态", () => {
    const store = new ServerEventStore();
    store.consume({ method: "thread/realtime/transcript/done", params: { threadId: "thread-1", role: "assistant", text: "转写结果" } });
    store.consume({ method: "thread/realtime/outputAudio/delta", params: { threadId: "thread-1", audio: { data: "AQACAA==", sampleRate: 24_000, numChannels: 1 } } });
    store.consume({ method: "thread/realtime/closed", params: { threadId: "thread-1", reason: "已结束" } });
    render(<ServerActivityPanel store={store} threadId="thread-1" />);
    openPanel();
    expect(screen.getByText("转写结果")).toBeVisible();
    expect(screen.getByRole("button", { name: "加载已接收音频" })).toBeVisible();
    expect(screen.queryByText("已完成")).not.toBeInTheDocument();
    expect(screen.queryByText("实时会话已关闭")).not.toBeInTheDocument();
  });

  it("汇总展示文件数与增删统计，按需挂载文件列表，点击仅打开所选文件差异", () => {
    const store = new ServerEventStore();
    const onOpenDiff = vi.fn();
    store.consume({ method: "turn/diff/updated", params: { threadId: "thread-1", turnId: "turn-1", diff: UPDATED_FILE_DIFF + DELETED_FILE_DIFF } });
    render(<ServerActivityPanel onOpenDiff={onOpenDiff} store={store} threadId="thread-1" />);
    openPanel();
    expect(screen.getByText("本轮汇总变更 · 2 个文件")).toBeVisible();
    expect(screen.getByLabelText("新增 1 行，删除 2 行")).toBeVisible();
    expect(screen.queryByRole("list", { name: "变更文件" })).not.toBeInTheDocument();
    expect(screen.queryByText("整轮文件变更")).not.toBeInTheDocument();

    const details = openDiffSummary();
    const files = screen.getByRole("list", { name: "变更文件" });
    expect(within(files).getAllByRole("listitem")).toHaveLength(2);
    fireEvent.click(within(files).getByRole("button", { name: "修改 src/App.tsx，新增 1 行，删除 1 行" }));
    expect(onOpenDiff).toHaveBeenLastCalledWith("src/App.tsx", UPDATED_FILE_DIFF);
    fireEvent.click(within(files).getByRole("button", { name: "删除 old.txt，新增 0 行，删除 1 行" }));
    expect(onOpenDiff).toHaveBeenLastCalledWith("old.txt", DELETED_FILE_DIFF);
    expect(screen.queryByText("+new line")).not.toBeInTheDocument();

    details.open = false;
    fireEvent(details, new Event("toggle"));
    expect(screen.queryByRole("list", { name: "变更文件" })).not.toBeInTheDocument();
  });

  it("同一回合更新时替换文件和统计，断线仍可查看收到的差异", () => {
    vi.useFakeTimers();
    const store = new ServerEventStore();
    const onOpenDiff = vi.fn();
    store.consume({ method: "turn/diff/updated", params: { threadId: "thread-1", turnId: "turn-1", diff: UPDATED_FILE_DIFF } });
    render(<ServerActivityPanel onOpenDiff={onOpenDiff} store={store} threadId="thread-1" />);
    openPanel();
    openDiffSummary();
    consume(store, { method: "turn/diff/updated", params: { threadId: "thread-1", turnId: "turn-1", diff: DELETED_FILE_DIFF } });
    expect(screen.getAllByText(/^本轮汇总变更/u)).toHaveLength(1);
    expect(screen.queryByText("src/App.tsx")).not.toBeInTheDocument();
    act(() => { store.disconnect(); vi.advanceTimersByTime(80); });
    expect(screen.getByText("连接已断开，显示最后收到的变更")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "删除 old.txt，新增 0 行，删除 1 行" }));
    expect(onOpenDiff).toHaveBeenCalledWith("old.txt", DELETED_FILE_DIFF);
  });

  it("截断补丁只统计能识别的文件，保留原始片段供按需查看", () => {
    const store = new ServerEventStore();
    store.consume({ method: "turn/diff/updated", params: { threadId: "thread-1", turnId: "turn-1", diff: `${"x".repeat(SERVER_EVENT_LIMITS.text)}\n${UPDATED_FILE_DIFF}` } });
    render(<ServerActivityPanel onOpenDiff={vi.fn()} store={store} threadId="thread-1" />);
    openPanel();
    expect(screen.getByText("本轮汇总变更 · 已识别 1 个文件")).toBeVisible();
    openDiffSummary();
    expect(screen.getByText("内容已截断，仅统计可识别文件")).toBeVisible();
    expect(screen.getByRole("button", { name: "修改 src/App.tsx，新增 1 行，删除 1 行" })).toBeVisible();
    expect(document.querySelector("pre")).toBeNull();
    const raw = screen.getByText("查看保留的原始补丁").closest("details")!;
    raw.open = true;
    fireEvent(raw, new Event("toggle"));
    expect(document.querySelector("pre")?.textContent).toContain(UPDATED_FILE_DIFF);
  });

  it.each([
    ["", "暂无文件变更"],
    ["@@ -1 +1 @@\n-old\n+new", "部分变更无法识别，仅统计可识别文件"],
  ])("空或缺少文件路径的补丁不伪造文件列表（%s）", (diff, message) => {
    const store = new ServerEventStore();
    store.consume({ method: "turn/diff/updated", params: { threadId: "thread-1", turnId: "turn-1", diff } });
    render(<ServerActivityPanel store={store} threadId="thread-1" />);
    openPanel();
    openDiffSummary();
    expect(screen.getByText(message)).toBeVisible();
    expect(screen.queryByRole("listitem")).not.toBeInTheDocument();
  });

  it("客户端失败仅展示和统计当前会话的请求", () => {
    render(<ServerActivityPanel store={null} threadId="thread-1" failures={[
      { key: "1", threadId: "thread-1", message: "客户端没有注册动态工具" },
      { key: "2", threadId: null, message: "外部认证刷新不可用" },
      { key: "3", threadId: "thread-2", message: "另一个会话的失败" },
    ]} />);
    expect(screen.getByRole("button", { name: "运行状态 · 1 项需注意" })).toBeVisible();
    openPanel();
    expect(screen.getByText("客户端没有注册动态工具")).toBeVisible();
    expect(screen.queryByText("外部认证刷新不可用")).not.toBeInTheDocument();
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

  it("显示当前会话队列中的非文本输入，隐藏全局项目", () => {
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
    expect(screen.queryByText("项目 · 1 个")).not.toBeInTheDocument();
    expect(screen.queryByText("协议客户端")).not.toBeInTheDocument();
    expect(screen.queryByText("/workspace/client")).not.toBeInTheDocument();
  });

  it("无目标、空队列和空项目不会产生空面板", () => {
    const store = new ServerEventStore();
    store.hydrateGoal("thread-1", 0, null);
    store.consume({ method: "thread/queue/changed", params: { threadId: "thread-1" } });
    store.hydrateQueue("thread-1", 1, []);
    store.hydrateProjects(0, []);
    render(<ServerActivityPanel store={store} threadId="thread-1" />);
    expect(screen.queryByRole("button", { name: /^运行状态/u })).not.toBeInTheDocument();
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
