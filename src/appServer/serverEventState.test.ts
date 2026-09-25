import { describe, expect, it, vi } from "vitest";
import { KNOWN_SERVER_NOTIFICATION_METHODS } from "../protocol/generated/methods";
import type { HookRunSummary, ThreadGoal, ThreadTokenUsage } from "../protocol/generated/types/ServerNotification";
import { SERVER_EVENT_LIMITS, SERVER_NOTIFICATION_POLICIES, ServerEventStore } from "./serverEventState";

const key = (...parts: string[]) => JSON.stringify(parts);
const goal = (objective = "完成测试"): ThreadGoal => ({ objective, createdAt: 1, updatedAt: 2, status: "active", threadId: "t", tokensUsed: 40, tokenBudget: 100, timeUsedSeconds: 3 });
const usage = (totalTokens: number): ThreadTokenUsage => ({ last: { totalTokens, cachedInputTokens: 1, inputTokens: totalTokens, outputTokens: 0, reasoningOutputTokens: 0 }, total: { totalTokens, cachedInputTokens: 1, inputTokens: totalTokens, outputTokens: 0, reasoningOutputTokens: 0 }, modelContextWindow: 100 });
const hook = (status: HookRunSummary["status"]): HookRunSummary => ({ id: "h", status, displayOrder: 1, entries: [{ kind: "feedback", text: "检查中" }], eventName: "preToolUse", executionMode: "sync", handlerType: "command", scope: "turn", sourcePath: "/tmp/hook", startedAt: 1 });
const b64 = (bytes: number[]) => btoa(String.fromCharCode(...bytes));

describe("ServerEventStore", () => {
  it("淘汰展示实体后仍拒绝更早的零版本查询", () => {
    const store = new ServerEventStore();
    store.consume({ method: "thread/queue/changed", params: { threadId: "old" } });
    store.consume({ method: "thread/goal/cleared", params: { threadId: "old" } });
    for (let index = 0; index <= SERVER_EVENT_LIMITS.entities; index += 1) {
      const threadId = `thread-${index}`;
      store.consume({ method: "thread/queue/changed", params: { threadId } });
      store.consume({ method: "thread/goal/cleared", params: { threadId } });
    }
    expect(store.getSnapshot().queuesByThread.old).toBeUndefined();
    expect(store.getSnapshot().goalsByThread.old).toBeUndefined();
    expect(store.hydrateQueue("old", 0, [])).toBe(false);
    expect(store.hydrateGoal("old", 0, goal())).toBe(false);
  });

  it("为每种协议通知声明业务归属、语义与恢复契约", () => {
    expect(Object.keys(SERVER_NOTIFICATION_POLICIES).sort()).toEqual([...KNOWN_SERVER_NOTIFICATION_METHODS].sort());
    for (const entry of Object.values(SERVER_NOTIFICATION_POLICIES)) {
      expect(entry.owner).toBeTruthy();
      expect(entry.semantics).toBeTruthy();
      expect(entry.recovery).toBeTruthy();
    }
  });

  it("Token与整轮diff按到达次序替换快照，不累计或按时间倒排", () => {
    const store = new ServerEventStore();
    store.consume({ method: "thread/tokenUsage/updated", emittedAtMs: 99, params: { threadId: "t", turnId: "r", tokenUsage: usage(80) } });
    store.consume({ method: "thread/tokenUsage/updated", emittedAtMs: 1, params: { threadId: "t", turnId: "r2", tokenUsage: usage(5) } });
    store.consume({ method: "turn/diff/updated", params: { threadId: "t", turnId: "r", diff: "old" } });
    store.consume({ method: "turn/diff/updated", params: { threadId: "t", turnId: "r", diff: "new" } });
    expect(store.getSnapshot().tokenUsageByThread.t).toMatchObject({ turnId: "r2", tokenUsage: usage(5), stale: false });
    expect(store.getSnapshot().diffsByTurn[key("t", "r")]?.diff).toBe("new");
    expect(store.getSnapshot().records).toHaveLength(1);
    store.disconnect();
    expect(store.getSnapshot().tokenUsageByThread.t?.stale).toBe(true);
    expect(store.getSnapshot().diffsByTurn[key("t", "r")]?.stale).toBe(true);
  });

  it("目标更新和清除胜过迟到查询，删除会话不被迟到响应复活", () => {
    const store = new ServerEventStore();
    expect(store.hydrateGoal("t", 0, goal("快照"))).toBe(true);
    store.consume({ method: "thread/goal/updated", params: { threadId: "t", goal: goal("推送") } });
    expect(store.hydrateGoal("t", 0, goal("过期"))).toBe(false);
    expect(store.getSnapshot().goalsByThread.t?.goal?.objective).toBe("推送");
    store.consume({ method: "thread/goal/cleared", params: { threadId: "t" } });
    expect(store.getSnapshot().goalsByThread.t?.goal).toBe(null);
    expect(store.hydrateGoal("t", 1, goal())).toBe(false);
    store.consume({ method: "thread/deleted", params: { threadId: "t" } });
    expect(store.getSnapshot().goalsByThread.t).toBeUndefined();
    expect(store.hydrateGoal("t", store.getSnapshot().goalVersionsByThread.t!, goal())).toBe(false);
    expect(store.getSnapshot().deletedThreadIds).toContain("t");
  });

  it("队列只接受匹配版本，保留有界文本和非文本摘要", () => {
    const store = new ServerEventStore();
    const input = [{ id: "q", clientUserMessageId: "u", input: [{ type: "text" as const, text: "运行测试" }, { type: "image" as const, url: "data:image/png;base64,SECRET" }, { type: "localImage" as const, path: "/tmp/image.png" }, { type: "skill" as const, path: "/tmp/skill", name: "test" }] }];
    expect(store.hydrateQueue("t", 0, input)).toBe(true);
    expect(store.getSnapshot().queuesByThread.t?.entries[0]?.inputs).toEqual([{ type: "text", text: "运行测试" }, { type: "image" }, { type: "localImage", path: "/tmp/image.png" }, { type: "skill", path: "/tmp/skill", name: "test" }]);
    expect(JSON.stringify(store.getSnapshot())).not.toContain("SECRET");
    expect(store.getSnapshot().records[0]?.detail).toBe("1 条待处理输入");
    store.consume({ method: "thread/queue/changed", params: { threadId: "t" } });
    expect(store.hydrateQueue("t", 0, [])).toBe(false);
    expect(store.getSnapshot().queuesByThread.t?.status).toBe("pending");
    store.failQueue("t", 1, "查询失败");
    expect(store.getSnapshot().queuesByThread.t?.status).toBe("error");
  });

  it("Hook与自动审批以稳定ID更新生命周期，断线不伪造完成", () => {
    const store = new ServerEventStore();
    store.consume({ method: "hook/started", params: { threadId: "t", turnId: "r", run: hook("running") } });
    store.consume({ method: "hook/completed", params: { threadId: "t", turnId: "r", run: { ...hook("completed"), durationMs: 10 } } });
    const review = { action: { type: "command" as const, command: "ls", cwd: "/tmp", source: "shell" as const }, review: { status: "inProgress" as const }, reviewId: "review", startedAtMs: 1, threadId: "t", turnId: "r" };
    store.consume({ method: "item/autoApprovalReview/started", params: review });
    expect(store.getSnapshot().records).toHaveLength(2);
    store.disconnect();
    expect(store.getSnapshot().records[0]?.status).toBe("completed");
    expect(store.getSnapshot().records[1]?.status).toBe("unknown");
    expect(store.hydrateQueue("t", 0, [])).toBe(false);
  });

  it("MCP进度由item最终状态收尾，正常item不复制活动记录", () => {
    const store = new ServerEventStore();
    const item = { id: "i", type: "mcpToolCall" as const, server: "srv", tool: "tool", arguments: {}, status: "inProgress" as const };
    store.consume({ method: "item/started", params: { threadId: "t", turnId: "r", startedAtMs: 1, item } });
    expect(store.getSnapshot().records).toHaveLength(0);
    store.consume({ method: "item/mcpToolCall/progress", params: { threadId: "t", turnId: "r", itemId: "i", message: "下载中" } });
    store.consume({ method: "item/completed", params: { threadId: "t", turnId: "r", completedAtMs: 2, item: { ...item, status: "completed" } } });
    expect(store.getSnapshot().records[0]).toMatchObject({ detail: "下载中", status: "completed" });
  });

  it("stdout/stderr分别解码并支持跨base64块的UTF-8字符", () => {
    const store = new ServerEventStore();
    store.consume({ method: "process/outputDelta", params: { processHandle: "p", stream: "stdout", deltaBase64: b64([0xe4, 0xbd]), capReached: false } });
    store.consume({ method: "process/outputDelta", params: { processHandle: "p", stream: "stderr", deltaBase64: b64([0x45]), capReached: false } });
    store.consume({ method: "process/outputDelta", params: { processHandle: "p", stream: "stdout", deltaBase64: b64([0xa0]), capReached: false } });
    const exited = { method: "process/exited" as const, params: { processHandle: "p", exitCode: 0, stdout: "", stderr: "", stdoutCapReached: false, stderrCapReached: false } };
    store.consume(exited);
    store.consume(exited);
    expect(store.getSnapshot().processes[key("process", "p")]).toMatchObject({ stdout: "你", stderr: "E", status: "completed" });
    store.consume({ method: "process/outputDelta", params: { processHandle: "p", stream: "stdout", deltaBase64: b64([0x4e]), capReached: true } });
    expect(store.getSnapshot().processes[key("process", "p")]).toMatchObject({ stdout: "N", stderr: "", stdoutTruncated: true });
  });

  it("非流式退出捕获和命令响应都可完成状态，显式开始支持句柄重用", () => {
    const store = new ServerEventStore();
    store.consume({ method: "process/exited", params: { processHandle: "p", exitCode: 1, stdout: "out", stderr: "err", stdoutCapReached: false, stderrCapReached: true } });
    expect(store.getSnapshot().processes[key("process", "p")]).toMatchObject({ status: "failed", stdout: "out", stderr: "err", stderrTruncated: true });
    store.startProcess("command", "c");
    store.consume({ method: "command/exec/outputDelta", params: { processId: "c", stream: "stdout", deltaBase64: b64([0x41]), capReached: false } });
    store.completeCommand("c", { exitCode: 0, stdout: "", stderr: "" });
    expect(store.getSnapshot().processes[key("command", "c")]).toMatchObject({ status: "completed", stdout: "A" });
    store.startProcess("command", "c");
    store.completeCommand("c", { exitCode: 0, stdout: "new", stderr: "" });
    expect(store.getSnapshot().processes[key("command", "c")]?.stdout).toBe("new");
    store.startProcess("command", "c");
    store.disconnect();
    store.failCommand("c");
    expect(store.getSnapshot().processes[key("command", "c")]?.status).toBe("unknown");
  });

  it("实时转写done替换当前片段而不是再追加，保留后续同角色分段", () => {
    const store = new ServerEventStore();
    store.consume({ method: "thread/realtime/started", params: { threadId: "t", version: "v3", realtimeSessionId: "realtime" } });
    store.consume({ method: "thread/realtime/transcript/delta", params: { threadId: "t", role: "user", delta: "草稿" } });
    store.consume({ method: "thread/realtime/transcript/done", params: { threadId: "t", role: "user", text: "完整文本" } });
    store.consume({ method: "thread/realtime/transcript/delta", params: { threadId: "t", role: "user", delta: "下一段" } });
    expect(store.getSnapshot().realtimeByThread.t?.transcripts.map((entry) => entry.text)).toEqual(["完整文本", "下一段"]);
  });

  it("实时音频按格式与item分组并限制总缓存，SDP凭据不进入展示记录", () => {
    const store = new ServerEventStore();
    const audio = { data: b64([0, 1, 2, 3]), numChannels: 1, sampleRate: 24_000, itemId: "i" };
    for (let index = 0; index < SERVER_EVENT_LIMITS.entities + 1; index++) store.consume({ method: "thread/realtime/outputAudio/delta", params: { threadId: "t", audio } });
    expect(store.getSnapshot().realtimeByThread.t?.chunks).toHaveLength(SERVER_EVENT_LIMITS.entities);
    expect(store.getSnapshot().realtimeByThread.t?.audioTruncated).toBe(true);
    store.consume({ method: "thread/realtime/outputAudio/delta", params: { threadId: "t", audio: { ...audio, sampleRate: 48_000 } } });
    expect(store.getSnapshot().realtimeByThread.t?.chunks).toHaveLength(1);
    store.consume({ method: "thread/realtime/sdp", params: { threadId: "t", sdp: "v=0\na=ice-pwd:SECRET" } });
    expect(JSON.stringify(store.getSnapshot().records)).not.toContain("SECRET");
    store.disconnect();
    expect(store.getSnapshot().realtimeByThread.t?.chunks).toHaveLength(0);
    expect(store.getSnapshot().realtimeByThread.t?.sdp).toBeUndefined();
  });

  it("项目、环境、远程控制与文件变化生成可恢复的独立状态", () => {
    const store = new ServerEventStore();
    store.consume({ method: "project/changed", params: { projectId: "p", changeType: "deleted" } });
    expect(store.hydrateProjects(0, [])).toBe(false);
    expect(store.hydrateProjects(1, [])).toBe(true);
    store.consume({ method: "thread/project/updated", params: { threadId: "t", projectId: null } });
    store.consume({ method: "thread/environment/connected", params: { threadId: "t", environmentId: "e" } });
    store.consume({ method: "remoteControl/status/changed", params: { installationId: "device", serverName: "desktop", status: "connected" } });
    store.consume({ method: "fs/changed", params: { watchId: "w", changedPaths: ["/tmp/a"] } });
    store.consume({ method: "fs/changed", params: { watchId: "w", changedPaths: ["/tmp/a", "/tmp/b"] } });
    expect(store.getSnapshot().fsVersionsByWatch.w).toMatchObject({ version: 2, changedPaths: ["/tmp/a", "/tmp/b"] });
    expect(store.getSnapshot().projectsByThread.t).toBeNull();
    store.disconnect();
    expect(store.getSnapshot().environmentsByThread.t?.status).toBe("unknown");
    expect(store.getSnapshot().remoteControl?.stale).toBe(true);
  });

  it("搜索快照替换与完成分离，导入进度按类型合并并被最终结果替换", () => {
    const store = new ServerEventStore();
    store.consume({ method: "fuzzyFileSearch/sessionUpdated", params: { sessionId: "s", query: "old", files: [] } });
    store.consume({ method: "fuzzyFileSearch/sessionUpdated", params: { sessionId: "s", query: "new", files: [] } });
    store.consume({ method: "fuzzyFileSearch/sessionCompleted", params: { sessionId: "s" } });
    expect(store.getSnapshot().searches.s).toMatchObject({ query: "new", status: "completed" });
    store.consume({ method: "externalAgentConfig/import/progress", params: { importId: "i", itemTypeResults: [{ itemType: "AGENTS_MD", failures: [], successes: [] }] } });
    store.consume({ method: "externalAgentConfig/import/completed", params: { importId: "i", itemTypeResults: [] } });
    expect(store.getSnapshot().imports.i).toEqual({ results: [], status: "completed" });
  });

  it("长参数先脱敏再截断，告警有界且诊断不暴露未知method", () => {
    const store = new ServerEventStore();
    store.consume({ method: "turn/moderationMetadata", params: { threadId: "t", turnId: "r", metadata: { accessToken: "SECRET", padding: "x".repeat(20_000), password: "AFTER_LIMIT" } } });
    expect(JSON.stringify(store.getSnapshot().records)).not.toContain("SECRET");
    expect(JSON.stringify(store.getSnapshot().records)).not.toContain("AFTER_LIMIT");
    expect(store.getSnapshot().records[0]?.truncated).toBe(true);
    store.recordDiagnostic({ code: "unknown_notification", method: "SECRET_FROM_SERVER" });
    expect(JSON.stringify(store.getSnapshot().records)).not.toContain("SECRET_FROM_SERVER");
    for (let index = 0; index < SERVER_EVENT_LIMITS.records + 1; index++) store.consume({ method: "warning", params: { message: String(index) } });
    expect(store.getSnapshot().records).toHaveLength(SERVER_EVENT_LIMITS.records);
    expect(store.getSnapshot().droppedRecords).toBe(3);
  });

  it("记录及文本容量独立，监听器只响应有业务变化的通知", () => {
    const store = new ServerEventStore();
    const listener = vi.fn();
    const release = store.subscribe(listener);
    store.consume({ method: "item/agentMessage/delta", params: { threadId: "t", turnId: "r", itemId: "i", delta: "hello" } });
    expect(listener).not.toHaveBeenCalled();
    store.consume({ method: "turn/diff/updated", params: { threadId: "t", turnId: "r", diff: "x".repeat(SERVER_EVENT_LIMITS.text + 1) } });
    expect(store.getSnapshot().diffsByTurn[key("t", "r")]).toMatchObject({ truncated: true });
    expect(store.getSnapshot().diffsByTurn[key("t", "r")]?.diff).toHaveLength(SERVER_EVENT_LIMITS.text);
    expect(listener).toHaveBeenCalledOnce();
    release();
    store.clear();
    expect(listener).toHaveBeenCalledOnce();
  });
});
