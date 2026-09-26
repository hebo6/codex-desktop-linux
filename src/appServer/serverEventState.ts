import type { ProjectListResponse, ServerNotification, ThreadQueueListResponse } from "../protocol/generated";
import { isKnownServerNotificationMethod, type KnownServerNotificationMethod } from "../protocol/generated/methods";
import type { RpcDiagnostic } from "../protocol/rpc/types";
import type {
  ExternalAgentConfigImportTypeResult,
  FuzzyFileSearchResult,
  ThreadGoal,
  ThreadRealtimeAudioChunk,
  ThreadTokenUsage,
} from "../protocol/generated/types/ServerNotification";

type Payload<M extends KnownServerNotificationMethod> = Extract<ServerNotification, { method: M }>["params"];
type Owner = "conversation" | "account" | "interaction" | "serverEvents";
export interface ServerNotificationPolicy {
  readonly owner: Owner;
  readonly semantics: string;
  readonly recovery: string;
}
const policy = (owner: Owner, semantics: string, recovery: string): ServerNotificationPolicy => ({ owner, semantics, recovery });
const history = "重新读取会话快照；瞬时增量不可重放";
const transient = "断线后标记未知；等待新通知，不推断完成";

// This is deliberately exhaustive: a protocol update must choose a consumer and recovery contract.
export const SERVER_NOTIFICATION_POLICIES = {
  "account/gatewayOAuth/changed": policy("serverEvents", "按提供方替换网关认证状态，不保存授权URL", "account/gatewayOAuth/read"),
  "account/login/completed": policy("serverEvents", "记录登录结果，触发账户刷新", "account/read"),
  "account/rateLimits/updated": policy("account", "合并稀疏限额值；null不清除已有元数据", "account/rateLimits/read"),
  "account/updated": policy("account", "刷新账户身份和用量", "account/read"),
  "app/list/updated": policy("serverEvents", "替换应用列表并递增缓存版本", "app/list"),
  "autoApprovalReview/strictReviewRequired": policy("serverEvents", "显示严格审查要求", transient),
  "command/exec/outputDelta": policy("serverEvents", "按进程及流解码base64字节并顺序追加", "连接断开后命令终止；保留已收到的输出"),
  "configWarning": policy("serverEvents", "保存配置位置、原因与处理建议", "保留已收到的告警"),
  "deprecationNotice": policy("serverEvents", "保存弃用说明与迁移建议", "保留已收到的告警"),
  "error": policy("serverEvents", "区分重试与失败，保存原因", transient),
  "externalAgentConfig/import/completed": policy("serverEvents", "用最终各类型导入结果替换过程结果", transient),
  "externalAgentConfig/import/progress": policy("serverEvents", "按条目类型合并导入进度", transient),
  "fs/changed": policy("serverEvents", "按watchId累加失效版本和变化路径", "重新读取受影响文件并恢复监听"),
  "fuzzyFileSearch/sessionCompleted": policy("serverEvents", "结束对应搜索会话，保留最新结果", "重新发起搜索"),
  "fuzzyFileSearch/sessionUpdated": policy("serverEvents", "按sessionId替换查询与结果", "重新发起搜索"),
  "guardianWarning": policy("serverEvents", "保存会话审批告警", "保留已收到的告警"),
  "hook/completed": policy("serverEvents", "以run.id替换Hook最终结果和输出", history),
  "hook/started": policy("serverEvents", "以run.id建立Hook运行状态", history),
  "item/agentMessage/delta": policy("conversation", "按item追加正文", history),
  "item/autoApprovalReview/completed": policy("serverEvents", "以reviewId替换审批结果及原因", transient),
  "item/autoApprovalReview/started": policy("serverEvents", "以reviewId建立审批运行状态", transient),
  "item/commandExecution/outputDelta": policy("conversation", "按item顺序追加命令文本输出", history),
  "item/commandExecution/terminalInteraction": policy("serverEvents", "按item追加终端输入记录", history),
  "item/completed": policy("conversation", "以最终item替换增量，并收尾MCP进度", history),
  "item/fileChange/outputDelta": policy("serverEvents", "显式消费已弃用的补丁文本输出", "新服务器不发送；保留已收到的文本"),
  "item/fileChange/patchUpdated": policy("conversation", "替换item的文件变更快照", history),
  "item/mcpToolCall/progress": policy("serverEvents", "替换对应MCP调用最新进度", history),
  "item/plan/delta": policy("conversation", "追加计划草稿，完成item覆盖草稿", history),
  "item/reasoning/summaryPartAdded": policy("conversation", "按summaryIndex建立推理摘要分段", history),
  "item/reasoning/summaryTextDelta": policy("conversation", "按summaryIndex追加推理摘要", history),
  "item/reasoning/textDelta": policy("conversation", "按contentIndex追加推理正文", history),
  "item/started": policy("conversation", "建立会话item及MCP生命周期", history),
  "mcpServer/event/stream/notification": policy("serverEvents", "记录订阅及事件方法，不解释或保存事件载荷", "重新建立MCP事件订阅"),
  "mcpServer/oauthLogin/completed": policy("serverEvents", "显示OAuth结果并使MCP状态失效", "mcpServerStatus/list"),
  "mcpServer/startupStatus/updated": policy("serverEvents", "按会话和服务器名称替换启动状态", "mcpServerStatus/list"),
  "model/rerouted": policy("serverEvents", "记录模型切换原因与实际模型", transient),
  "model/safetyBuffering/updated": policy("serverEvents", "替换缓冲状态、原因和更快模型建议", transient),
  "model/verification": policy("serverEvents", "替换回合模型验证快照", transient),
  "modelProvider/authRecoveryCompleted": policy("serverEvents", "按回合和提供方完成认证恢复状态", transient),
  "modelProvider/authRecoveryStarted": policy("serverEvents", "按回合和提供方建立认证恢复状态", transient),
  "process/exited": policy("serverEvents", "收尾分流输出，合并非流式捕获并记录退出码", "断线后进程状态未知"),
  "process/outputDelta": policy("serverEvents", "按processHandle及流增量解码base64字节", "断线后进程状态未知"),
  "project/changed": policy("serverEvents", "保存项目变更类型并使项目缓存失效", "project/list"),
  "remoteControl/status/changed": policy("serverEvents", "替换远程连接和设备身份状态", "remoteControl/status/read"),
  "serverRequest/resolved": policy("interaction", "移除其他客户端已完成的待处理交互", "断线清除待处理请求"),
  "skills/changed": policy("serverEvents", "使当前技能查询失效", "skills/list使用当前查询参数"),
  "thread/archived": policy("conversation", "更新会话归档列表", "thread/list"),
  "thread/attachment/updated": policy("serverEvents", "按附件替换创建或删除状态", "thread/attachment/list"),
  "thread/closed": policy("serverEvents", "结束会话订阅，把未完成瞬时活动标未知", "重新订阅并读取thread/read"),
  "thread/compacted": policy("serverEvents", "记录已弃用压缩通知，不伪造历史item", history),
  "thread/deleted": policy("serverEvents", "删除该会话所有附加状态和活动", "thread/list"),
  "thread/environment/connected": policy("serverEvents", "替换会话已连接环境", transient),
  "thread/environment/disconnected": policy("serverEvents", "记录指定环境已断开", transient),
  "thread/goal/cleared": policy("serverEvents", "清除目标快照", "thread/goal/get"),
  "thread/goal/updated": policy("serverEvents", "替换目标、预算与用量快照", "thread/goal/get"),
  "thread/name/updated": policy("conversation", "替换会话名称", "thread/read"),
  "thread/project/updated": policy("serverEvents", "替换项目归属，null表示解除关联", "thread/read"),
  "thread/queue/changed": policy("serverEvents", "递增队列版本并查询全量队列", "thread/queue/list"),
  "thread/realtime/closed": policy("serverEvents", "结束实时流并保存关闭原因", "重新建立实时会话"),
  "thread/realtime/error": policy("serverEvents", "标记实时流失败并保存原因", "重新建立实时会话"),
  "thread/realtime/item/completed": policy("serverEvents", "以规范时间线条目替换最终记录，不重复合入扁平转写流", "thread/timeline/list"),
  "thread/realtime/item/started": policy("serverEvents", "以item.id建立实时条目状态，不重复合入扁平转写流", "thread/timeline/list"),
  "thread/realtime/item/transcript/delta": policy("serverEvents", "按itemId追加实时条目文本，不重复合入扁平转写流", "thread/timeline/list"),
  "thread/realtime/itemAdded": policy("serverEvents", "保存有界非音频实时条目", "不重放瞬时条目"),
  "thread/realtime/outputAudio/delta": policy("serverEvents", "计数音频字节，保留有界最新片段及格式", "音频无法重放；明确标记丢弃"),
  "thread/realtime/sdp": policy("serverEvents", "替换远端SDP协商描述", "重新协商实时连接"),
  "thread/realtime/started": policy("serverEvents", "重置实时会话及转写缓冲", "重新建立实时会话"),
  "thread/realtime/transcript/delta": policy("serverEvents", "按role追加当前转写片段", "转写瞬时增量无法重放"),
  "thread/realtime/transcript/done": policy("serverEvents", "用完整文本替换对应role的当前片段", "保留已完成片段"),
  "thread/reverted": policy("serverEvents", "清除无法定位保留回合的派生快照并重新读取历史", "thread/read"),
  "thread/settings/updated": policy("conversation", "替换会话设置", "thread/read"),
  "thread/started": policy("conversation", "接收会话初始快照", "thread/read"),
  "thread/status/changed": policy("conversation", "替换会话运行状态", "thread/read"),
  "thread/tokenUsage/updated": policy("serverEvents", "替换累计及最近请求Token快照，保留turnId", "基线thread/read不提供Token用量；重连标记过期并等待新推送"),
  "thread/unarchived": policy("conversation", "更新会话归档列表", "thread/list"),
  "turn/completed": policy("conversation", "替换回合快照并使未结束附属活动状态失效", history),
  "turn/diff/updated": policy("serverEvents", "替换整轮汇总diff，不追加", "没有独立diff回查；重连标记过期"),
  "turn/moderationMetadata": policy("serverEvents", "保存回合审核元数据快照", transient),
  "turn/plan/updated": policy("conversation", "useTurnPlan替换回合步骤和解释，TaskPlanPanel展示", transient),
  "turn/started": policy("conversation", "建立回合快照", history),
  "warning": policy("serverEvents", "保存全局或会话告警", "保留已收到的告警"),
  "windows/worldWritableWarning": policy("serverEvents", "展示平台沙箱扫描告警及路径", "保留已收到的平台诊断"),
  "windowsSandbox/setupCompleted": policy("serverEvents", "展示平台沙箱初始化结果", "保留已收到的平台诊断"),
} satisfies Record<KnownServerNotificationMethod, ServerNotificationPolicy>;

export type ServerEventStatus = "running" | "completed" | "failed" | "warning" | "unknown" | "info";
export interface ServerEventRecord {
  readonly id: string;
  readonly method: KnownServerNotificationMethod | "protocol/diagnostic";
  readonly title: string;
  readonly detail: string;
  readonly status: ServerEventStatus;
  readonly threadId?: string | undefined;
  readonly turnId?: string | undefined;
  readonly text?: string | undefined;
  readonly params?: unknown;
  readonly truncated?: boolean;
}
export type QueuedSubmission = ThreadQueueListResponse["data"][number];
export type QueueInputPreview =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "localImage" | "localAudio"; readonly path: string }
  | { readonly type: "skill" | "mention"; readonly name: string; readonly path: string }
  | { readonly type: "image" | "audio" };
export interface QueuedSubmissionSummary { readonly id: string; readonly clientUserMessageId: string; readonly text: string; readonly inputs: readonly QueueInputPreview[]; readonly truncated: boolean }
export interface ServerQueueState {
  readonly version: number;
  readonly status: "pending" | "ready" | "error" | "unknown";
  readonly entries: readonly QueuedSubmissionSummary[];
  readonly error?: string;
}
export interface ServerProcessState {
  readonly id: string;
  readonly kind: "command" | "process";
  readonly status: ServerEventStatus;
  readonly stdout: string;
  readonly stderr: string;
  readonly stdoutTruncated: boolean;
  readonly stderrTruncated: boolean;
  readonly exitCode?: number;
}
export interface RealtimeTranscript { readonly role: string; readonly text: string; readonly completed: boolean; readonly truncated: boolean }
export interface ServerRealtimeState {
  readonly status: ServerEventStatus;
  readonly sessionId?: string | null | undefined;
  readonly version?: string;
  readonly transcripts: readonly RealtimeTranscript[];
  readonly audioChunks: number;
  readonly audioBytes: number;
  readonly audioTruncated: boolean;
  readonly chunks: readonly ThreadRealtimeAudioChunk[];
  readonly latestAudio?: ThreadRealtimeAudioChunk | undefined;
  readonly sdp?: string | undefined;
}
export interface ServerEventSnapshot {
  readonly connected: boolean;
  readonly deletedThreadIds: readonly string[];
  readonly records: readonly ServerEventRecord[];
  readonly droppedRecords: number;
  readonly tokenUsageByThread: Readonly<Record<string, { readonly threadId: string; readonly turnId: string; readonly tokenUsage: ThreadTokenUsage; readonly stale: boolean }>>;
  readonly goalsByThread: Readonly<Record<string, { readonly goal: ThreadGoal | null; readonly stale: boolean }>>;
  readonly goalVersionsByThread: Readonly<Record<string, number>>;
  readonly diffsByTurn: Readonly<Record<string, { readonly threadId: string; readonly turnId: string; readonly diff: string; readonly truncated: boolean; readonly stale: boolean }>>;
  readonly queueVersionsByThread: Readonly<Record<string, number>>;
  readonly queuesByThread: Readonly<Record<string, ServerQueueState>>;
  readonly skillsVersion: number;
  readonly appVersion: number;
  readonly projectVersion: number;
  readonly projectsSnapshot: { readonly version: number; readonly status: "pending" | "ready" | "error" | "unknown"; readonly entries: ProjectListResponse["data"]; readonly truncated: boolean; readonly error?: string };
  readonly mcpVersion: number;
  readonly projectChangesById: Readonly<Record<string, Payload<"project/changed">>>;
  readonly projectsByThread: Readonly<Record<string, string | null>>;
  readonly environmentsByThread: Readonly<Record<string, { readonly environmentId: string; readonly status: "connected" | "disconnected" | "unknown" }>>;
  readonly remoteControl: (Payload<"remoteControl/status/changed"> & { readonly stale: boolean }) | null;
  readonly fsVersionsByWatch: Readonly<Record<string, { readonly version: number; readonly changedPaths: readonly string[]; readonly truncated: boolean }>>;
  readonly searches: Readonly<Record<string, { readonly query: string; readonly files: readonly FuzzyFileSearchResult[]; readonly status: ServerEventStatus; readonly truncated: boolean }>>;
  readonly imports: Readonly<Record<string, { readonly results: readonly ExternalAgentConfigImportTypeResult[]; readonly status: ServerEventStatus }>>;
  readonly processes: Readonly<Record<string, ServerProcessState>>;
  readonly realtimeByThread: Readonly<Record<string, ServerRealtimeState>>;
}

export const SERVER_EVENT_LIMITS = { records: 200, entities: 100, text: 32_768, details: 8_192, audioBytes: 1_048_576 } as const;
const keyOf = (...parts: string[]): string => JSON.stringify(parts);
const clipped = (text: string, limit: number = SERVER_EVENT_LIMITS.text): string => text.slice(-limit);
const emptyRealtime = (): ServerRealtimeState => ({ status: "running", transcripts: [], chunks: [], audioChunks: 0, audioBytes: 0, audioTruncated: false });
const initialSnapshot = (): ServerEventSnapshot => ({
  connected: true, deletedThreadIds: [], goalVersionsByThread: {}, projectsSnapshot: { version: 0, status: "pending", entries: [], truncated: false },
  records: [], droppedRecords: 0, tokenUsageByThread: {}, goalsByThread: {}, diffsByTurn: {},
  queueVersionsByThread: {}, queuesByThread: {}, skillsVersion: 0, appVersion: 0, projectVersion: 0, mcpVersion: 0,
  projectChangesById: {}, projectsByThread: {}, environmentsByThread: {}, remoteControl: null, fsVersionsByWatch: {},
  searches: {}, imports: {}, processes: {}, realtimeByThread: {},
});
function put<T>(entries: Readonly<Record<string, T>>, key: string, value: T): Readonly<Record<string, T>> {
  return Object.fromEntries([...Object.entries(entries).filter(([entryKey]) => entryKey !== key), [key, value]].slice(-SERVER_EVENT_LIMITS.entities));
}
function omit<T>(entries: Readonly<Record<string, T>>, key: string): Readonly<Record<string, T>> {
  return Object.fromEntries(Object.entries(entries).filter(([entryKey]) => entryKey !== key));
}
// 版本与删除标记跟随连接存活；淘汰展示缓存不能让旧查询重新匹配初始版本
function versionEntry(entries: Readonly<Record<string, number>>, key: string, version: number): Readonly<Record<string, number>> {
  return { ...entries, [key]: version };
}
function mapValues<T>(entries: Readonly<Record<string, T>>, fn: (value: T) => T): Readonly<Record<string, T>> {
  return Object.fromEntries(Object.entries(entries).map(([key, value]) => [key, fn(value)]));
}

/** Connection-owned store. Receipt order is authoritative; emittedAtMs is never used for ordering. */
export class ServerEventStore {
  private snapshot: ServerEventSnapshot = initialSnapshot();
  private readonly listeners = new Set<() => void>();
  private readonly decoders = new Map<string, TextDecoder>();
  private readonly streamed = new Set<string>();
  private serial = 0;
  readonly getSnapshot = (): ServerEventSnapshot => this.snapshot;
  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  consume(notification: ServerNotification): void {
    const before = this.snapshot;
    switch (notification.method) {
      case "thread/tokenUsage/updated": {
        const p = notification.params;
        this.patch({ tokenUsageByThread: put(this.snapshot.tokenUsageByThread, p.threadId, { ...p, stale: false }) });
        break;
      }
      case "turn/diff/updated": {
        const p = notification.params;
        const truncated = p.diff.length > SERVER_EVENT_LIMITS.text;
        this.patch({ diffsByTurn: put(this.snapshot.diffsByTurn, keyOf(p.threadId, p.turnId), { ...p, diff: clipped(p.diff), truncated, stale: false }) });
        this.record(notification, "整轮文件变更", "本回合最新汇总差异", "info", keyOf("diff", p.threadId, p.turnId), p.threadId, p.turnId, p.diff, false);
        break;
      }
      case "thread/goal/updated": {
        const p = notification.params;
        this.patch({ goalsByThread: put(this.snapshot.goalsByThread, p.threadId, { goal: p.goal, stale: false }), goalVersionsByThread: versionEntry(this.snapshot.goalVersionsByThread, p.threadId, (this.snapshot.goalVersionsByThread[p.threadId] ?? 0) + 1) });
        this.record(notification, "会话目标", p.goal.objective, p.goal.status === "active" ? "running" : p.goal.status === "complete" ? "completed" : "warning", keyOf("goal", p.threadId), p.threadId, p.turnId ?? undefined);
        break;
      }
      case "thread/goal/cleared":
        this.patch({ goalsByThread: put(this.snapshot.goalsByThread, notification.params.threadId, { goal: null, stale: false }), goalVersionsByThread: versionEntry(this.snapshot.goalVersionsByThread, notification.params.threadId, (this.snapshot.goalVersionsByThread[notification.params.threadId] ?? 0) + 1) });
        this.record(notification, "会话目标已清除", "服务器已移除当前目标", "completed", keyOf("goal", notification.params.threadId), notification.params.threadId);
        break;
      case "thread/queue/changed": {
        const p = notification.params;
        const version = (this.snapshot.queueVersionsByThread[p.threadId] ?? 0) + 1;
        this.patch({ queueVersionsByThread: versionEntry(this.snapshot.queueVersionsByThread, p.threadId, version), queuesByThread: put(this.snapshot.queuesByThread, p.threadId, { version, status: "pending", entries: [] }) });
        this.record(notification, "输入队列变化", "正在刷新服务器队列", "running", keyOf("queue", p.threadId), p.threadId);
        break;
      }
      case "project/changed": {
        const p = notification.params;
        this.patch({ projectVersion: this.snapshot.projectVersion + 1, projectChangesById: put(this.snapshot.projectChangesById, p.projectId, p), projectsSnapshot: { ...this.snapshot.projectsSnapshot, version: this.snapshot.projectVersion + 1, status: "pending" } });
        this.record(notification, "项目变化", `${p.projectId} · ${p.changeType}`, "info", keyOf("project", p.projectId));
        break;
      }
      case "thread/project/updated": {
        const p = notification.params;
        this.patch({ projectsByThread: put(this.snapshot.projectsByThread, p.threadId, p.projectId) });
        this.record(notification, "会话项目更新", p.projectId === null ? "已解除项目关联" : p.projectId, "info", keyOf("project-thread", p.threadId), p.threadId);
        break;
      }
      case "thread/environment/connected":
      case "thread/environment/disconnected": {
        const p = notification.params;
        const connected = notification.method === "thread/environment/connected";
        this.patch({ environmentsByThread: put(this.snapshot.environmentsByThread, p.threadId, { environmentId: p.environmentId, status: connected ? "connected" : "disconnected" }) });
        this.record(notification, connected ? "执行环境已连接" : "执行环境已断开", p.environmentId, "info", keyOf("environment", p.threadId), p.threadId);
        break;
      }
      case "remoteControl/status/changed": {
        const p = notification.params;
        this.patch({ remoteControl: { ...p, stale: false } });
        this.record(notification, "远程控制", `${p.serverName} · ${p.status}`, p.status === "connecting" ? "running" : p.status === "errored" ? "failed" : "info", "remoteControl");
        break;
      }
      case "hook/started":
      case "hook/completed": {
        const p = notification.params;
        this.record(notification, `Hook · ${p.run.eventName}`, `${p.run.handlerType} · ${p.run.sourcePath}${p.run.statusMessage ? `\n${p.run.statusMessage}` : ""}`, p.run.status === "running" ? "running" : p.run.status === "completed" ? "completed" : "failed", keyOf("hook", p.threadId, p.run.id), p.threadId, p.turnId ?? undefined, p.run.entries.map((entry) => `[${entry.kind}] ${entry.text}`).join("\n"));
        break;
      }
      case "item/autoApprovalReview/started":
      case "item/autoApprovalReview/completed": {
        const p = notification.params;
        this.record(notification, `自动审批 · ${p.action.type}`, p.review.rationale ?? p.review.status, p.review.status === "inProgress" ? "running" : p.review.status === "approved" ? "completed" : "failed", keyOf("review", p.threadId, p.reviewId), p.threadId, p.turnId);
        break;
      }
      case "autoApprovalReview/strictReviewRequired":
        this.record(notification, "需要严格审查", "本回合要求更严格的自动审批审查", "warning", undefined, notification.params.threadId, notification.params.turnId);
        break;
      case "item/mcpToolCall/progress": {
        const p = notification.params;
        this.record(notification, "MCP 工具进度", p.message, "running", keyOf("mcp-call", p.threadId, p.turnId, p.itemId), p.threadId, p.turnId);
        break;
      }
      case "mcpServer/startupStatus/updated": {
        const p = notification.params;
        this.patch({ mcpVersion: this.snapshot.mcpVersion + 1 });
        this.record(notification, `MCP · ${p.name}`, p.error ?? p.failureReason ?? p.status, p.status === "starting" ? "running" : p.status === "ready" ? "completed" : "failed", keyOf("mcp-server", p.threadId ?? "", p.name), p.threadId ?? undefined);
        break;
      }
      case "mcpServer/oauthLogin/completed": {
        const p = notification.params;
        this.patch({ mcpVersion: this.snapshot.mcpVersion + 1 });
        this.record(notification, `MCP 认证 · ${p.name}`, p.success ? "认证成功" : p.error ?? "认证失败", p.success ? "completed" : "failed", undefined, p.threadId ?? undefined);
        break;
      }
      case "mcpServer/event/stream/notification": {
        const p = notification.params;
        this.record(notification, "MCP 订阅事件", `${p.subscriptionId} · ${p.notification.method}`, "info", undefined, undefined, undefined, undefined, false);
        break;
      }
      case "error": {
        const p = notification.params;
        this.record(notification, p.willRetry ? "正在重试" : "回合错误", p.error.message, p.willRetry ? "running" : "failed", keyOf("error", p.threadId, p.turnId), p.threadId, p.turnId, p.error.additionalDetails ?? undefined);
        break;
      }
      case "warning":
      case "guardianWarning":
        this.record(notification, notification.method === "warning" ? "服务器告警" : "审批告警", notification.params.message, "warning", undefined, notification.params.threadId ?? undefined);
        break;
      case "configWarning":
        this.record(notification, "配置告警", notification.params.summary, "warning", undefined, undefined, undefined, notification.params.details ?? undefined);
        break;
      case "deprecationNotice":
        this.record(notification, "弃用提醒", notification.params.summary, "warning", undefined, undefined, undefined, notification.params.details ?? undefined);
        break;
      case "model/rerouted": {
        const p = notification.params;
        this.record(notification, "模型已切换", `${p.fromModel} → ${p.toModel} · ${p.reason}`, "warning", keyOf("model", p.threadId, p.turnId), p.threadId, p.turnId);
        break;
      }
      case "model/safetyBuffering/updated": {
        const p = notification.params;
        this.record(notification, "模型安全缓冲", `${p.model} · ${p.showBufferingUi ? "正在缓冲" : "缓冲结束"}${p.reasons.length ? `\n${p.reasons.join("、")}` : ""}`, p.showBufferingUi ? "running" : "completed", keyOf("buffering", p.threadId, p.turnId), p.threadId, p.turnId);
        break;
      }
      case "model/verification": {
        const p = notification.params;
        this.record(notification, "模型验证", `${p.verifications.length} 项验证结果`, "info", keyOf("verification", p.threadId, p.turnId), p.threadId, p.turnId);
        break;
      }
      case "modelProvider/authRecoveryStarted":
      case "modelProvider/authRecoveryCompleted": {
        const p = notification.params;
        this.record(notification, `模型认证恢复 · ${p.provider}`, p.message, notification.method === "modelProvider/authRecoveryStarted" ? "running" : "completed", keyOf("auth-recovery", p.threadId, p.turnId, p.provider), p.threadId, p.turnId);
        break;
      }
      case "turn/moderationMetadata":
        this.record(notification, "回合审核信息", "服务器提供了审核元数据", "info", keyOf("moderation", notification.params.threadId, notification.params.turnId), notification.params.threadId, notification.params.turnId);
        break;
      case "item/commandExecution/terminalInteraction": {
        const p = notification.params;
        const id = keyOf("stdin", p.threadId, p.turnId, p.itemId);
        this.record(notification, "终端输入", `进程 ${p.processId}`, "info", id, p.threadId, p.turnId, (this.snapshot.records.find((entry) => entry.id === id)?.text ?? "") + p.stdin, false);
        break;
      }
      case "item/fileChange/outputDelta": {
        const p = notification.params;
        const id = keyOf("legacy-patch", p.threadId, p.turnId, p.itemId);
        this.record(notification, "补丁输出", "已弃用的补丁文本流", "info", id, p.threadId, p.turnId, (this.snapshot.records.find((entry) => entry.id === id)?.text ?? "") + p.delta, false);
        break;
      }
      case "command/exec/outputDelta":
        this.output("command", notification.params.processId, notification.params, notification);
        break;
      case "process/outputDelta":
        this.output("process", notification.params.processHandle, notification.params, notification);
        break;
      case "process/exited":
        this.processExited(notification);
        break;
      case "fuzzyFileSearch/sessionUpdated": {
        const p = notification.params;
        this.patch({ searches: put(this.snapshot.searches, p.sessionId, { query: p.query, files: p.files.slice(0, SERVER_EVENT_LIMITS.entities), status: "running", truncated: p.files.length > SERVER_EVENT_LIMITS.entities }) });
        this.record(notification, "文件搜索", `${p.query} · ${p.files.length} 个结果`, "running", keyOf("search", p.sessionId), undefined, undefined, p.files.slice(0, SERVER_EVENT_LIMITS.entities).map((file) => file.path).join("\n"), false);
        break;
      }
      case "fuzzyFileSearch/sessionCompleted": {
        const p = notification.params;
        const previous = this.snapshot.searches[p.sessionId];
        this.patch({ searches: put(this.snapshot.searches, p.sessionId, { query: previous?.query ?? "", files: previous?.files ?? [], truncated: previous?.truncated ?? false, status: "completed" }) });
        this.updateRecord(keyOf("search", p.sessionId), { status: "completed" });
        break;
      }
      case "externalAgentConfig/import/progress":
      case "externalAgentConfig/import/completed": {
        const p = notification.params;
        const completed = notification.method === "externalAgentConfig/import/completed";
        const results = completed ? p.itemTypeResults : [...(this.snapshot.imports[p.importId]?.results ?? []).filter((entry) => !p.itemTypeResults.some((next) => next.itemType === entry.itemType)), ...p.itemTypeResults];
        const failed = results.reduce((sum, entry) => sum + entry.failures.length, 0);
        const success = results.reduce((sum, entry) => sum + entry.successes.length, 0);
        const status = completed ? failed > 0 ? "warning" : "completed" : "running";
        const retained = results.slice(0, SERVER_EVENT_LIMITS.entities).map((entry) => ({ ...entry, failures: entry.failures.slice(0, SERVER_EVENT_LIMITS.entities).map((failure) => ({ ...failure, message: clipped(failure.message) })), successes: entry.successes.slice(0, SERVER_EVENT_LIMITS.entities) }));
        this.patch({ imports: put(this.snapshot.imports, p.importId, { results: retained, status }) });
        this.record(notification, "导入外部配置", `${success} 项成功 · ${failed} 项失败`, status, keyOf("import", p.importId));
        break;
      }
      case "fs/changed": {
        const p = notification.params;
        const previous = this.snapshot.fsVersionsByWatch[p.watchId];
        const paths = [...new Set([...(previous?.changedPaths ?? []), ...p.changedPaths])];
        this.patch({ fsVersionsByWatch: put(this.snapshot.fsVersionsByWatch, p.watchId, { version: (previous?.version ?? 0) + 1, changedPaths: paths.slice(-SERVER_EVENT_LIMITS.entities), truncated: previous?.truncated === true || paths.length > SERVER_EVENT_LIMITS.entities }) });
        this.record(notification, "文件监听变化", `监听 ${p.watchId} · ${p.changedPaths.length} 条路径变化`, "info", keyOf("fs", p.watchId), undefined, undefined, paths.join("\n"), false);
        break;
      }
      case "skills/changed":
        this.patch({ skillsVersion: this.snapshot.skillsVersion + 1 });
        this.record(notification, "技能已变化", "技能列表需要刷新", "info", "skills");
        break;
      case "app/list/updated":
        this.patch({ appVersion: this.snapshot.appVersion + 1 });
        this.record(notification, "应用列表已更新", `${notification.params.data.length} 个应用`, "info", "apps");
        break;
      case "account/login/completed":
        this.record(notification, "账户登录", notification.params.success ? "登录成功" : notification.params.error ?? "登录失败", notification.params.success ? "completed" : "failed");
        break;
      case "account/gatewayOAuth/changed": {
        const p = notification.params;
        const statuses = { notReady: "warning", started: "running", succeeded: "completed", failed: "failed" } satisfies Record<typeof p.status, ServerEventStatus>;
        this.record(notification, `网关认证 · ${p.providerId}`, p.error ?? p.status, statuses[p.status], keyOf("gateway-oauth", p.providerId), undefined, undefined, undefined, false);
        break;
      }
      case "thread/attachment/updated": {
        const p = notification.params;
        this.record(notification, p.operation === "created" ? "会话附件已创建" : "会话附件已删除", `${p.attachmentType} · ${p.attachmentId}`, "completed", keyOf("attachment", p.threadId, p.attachmentId), p.threadId);
        break;
      }
      case "windows/worldWritableWarning":
        this.record(notification, "Windows 沙箱目录告警", notification.params.failedScan ? "目录权限扫描失败" : `检测到所有用户可写的目录，另有 ${notification.params.extraCount} 条路径`, "warning", undefined, undefined, undefined, notification.params.samplePaths.join("\n"));
        break;
      case "windowsSandbox/setupCompleted":
        this.record(notification, "Windows 沙箱初始化", notification.params.success ? `${notification.params.mode} 初始化成功` : notification.params.error ?? "初始化失败", notification.params.success ? "completed" : "failed");
        break;
      case "thread/realtime/started":
      case "thread/realtime/itemAdded":
      case "thread/realtime/item/started":
      case "thread/realtime/item/transcript/delta":
      case "thread/realtime/item/completed":
      case "thread/realtime/transcript/delta":
      case "thread/realtime/transcript/done":
      case "thread/realtime/outputAudio/delta":
      case "thread/realtime/sdp":
      case "thread/realtime/error":
      case "thread/realtime/closed":
        this.realtime(notification);
        break;
      case "item/started":
      case "item/completed": {
        const p = notification.params;
        const progressId = keyOf("mcp-call", p.threadId, p.turnId, p.item.id);
        if (p.item.type === "mcpToolCall" && this.snapshot.records.some((entry) => entry.id === progressId)) {
          this.updateRecord(progressId, { status: p.item.status === "inProgress" ? "running" : p.item.status === "completed" ? "completed" : "failed" });
        }
        break;
      }
      case "turn/completed":
        this.finishThread(notification.params.threadId, notification.params.turn.id);
        break;
      case "thread/closed":
        this.finishThread(notification.params.threadId);
        this.record(notification, "会话订阅已关闭", "瞬时活动状态需重新确认", "info", undefined, notification.params.threadId);
        break;
      case "thread/deleted":
      case "thread/reverted":
        this.clearThread(notification.params.threadId);
        if (notification.method === "thread/deleted") this.patch({ deletedThreadIds: [...new Set([...this.snapshot.deletedThreadIds, notification.params.threadId])] });
        if (notification.method === "thread/reverted") this.record(notification, "会话历史已撤回", "已清除旧回合的派生状态，等待重新读取历史", "info", undefined, notification.params.threadId);
        break;
      case "thread/compacted":
        this.record(notification, "上下文已压缩", "服务器发送了旧版压缩完成通知", "completed", undefined, notification.params.threadId, notification.params.turnId);
        break;
      case "thread/settings/updated": {
        const p = notification.params;
        this.record(notification, "会话设置已更新", `${p.threadSettings.model} · ${p.threadSettings.cwd}`, "info", keyOf("settings", p.threadId), p.threadId);
        break;
      }
      // These owners consume the payload in their own typed reducers. Do not duplicate streamed history.
      case "account/updated": case "account/rateLimits/updated": case "serverRequest/resolved":
      case "thread/started": case "thread/status/changed": case "thread/archived": case "thread/unarchived":
      case "thread/name/updated": case "turn/started":
      case "turn/plan/updated":
      case "item/agentMessage/delta": case "item/plan/delta": case "item/commandExecution/outputDelta":
      case "item/fileChange/patchUpdated": case "item/reasoning/summaryPartAdded":
      case "item/reasoning/summaryTextDelta": case "item/reasoning/textDelta":
        break;
      default: {
        const unhandled: never = notification;
        throw new Error(`未实现的服务器通知：${String(unhandled)}`);
      }
    }
    if (before !== this.snapshot) this.publish();
  }

  hydrateQueue(threadId: string, version: number, entries: readonly QueuedSubmission[]): boolean {
    if (!this.canHydrateThread(threadId) || (this.snapshot.queueVersionsByThread[threadId] ?? 0) !== version) return false;
    const retained = entries.slice(0, SERVER_EVENT_LIMITS.entities).map((entry): QueuedSubmissionSummary => {
      const text = entry.input.filter((input) => input.type === "text").map((input) => input.text).join("\n");
      const inputs = entry.input.slice(0, SERVER_EVENT_LIMITS.entities).map((input): QueueInputPreview => {
        switch (input.type) {
          case "text": return { type: input.type, text: clipped(input.text) };
          case "localImage": case "localAudio": return { type: input.type, path: clipped(input.path, SERVER_EVENT_LIMITS.details) };
          case "skill": case "mention": return { type: input.type, name: clipped(input.name, SERVER_EVENT_LIMITS.details), path: clipped(input.path, SERVER_EVENT_LIMITS.details) };
          case "image": case "audio": return { type: input.type };
        }
      });
      return { id: entry.id, clientUserMessageId: entry.clientUserMessageId, text: clipped(text), inputs, truncated: text.length > SERVER_EVENT_LIMITS.text || entry.input.length > SERVER_EVENT_LIMITS.entities };
    });
    this.patch({ queuesByThread: put(this.snapshot.queuesByThread, threadId, { version, status: "ready", entries: retained }) });
    this.record({ method: "thread/queue/changed", params: { threadId } }, "输入队列", `${entries.length} 条待处理输入`, "completed", keyOf("queue", threadId), threadId, undefined, retained.map((entry) => entry.text).join("\n"), false);
    if (entries.length > retained.length || retained.some((entry) => entry.truncated)) this.updateRecord(keyOf("queue", threadId), { truncated: true });
    this.publish();
    return true;
  }
  failQueue(threadId: string, version: number, error: string): void {
    if (!this.canHydrateThread(threadId) || (this.snapshot.queueVersionsByThread[threadId] ?? 0) !== version) return;
    this.patch({ queuesByThread: put(this.snapshot.queuesByThread, threadId, { version, status: "error", entries: [], error: clipped(error) }) });
    this.updateRecord(keyOf("queue", threadId), { status: "failed", detail: `队列刷新失败：${error}` });
    this.publish();
  }
  hydrateGoal(threadId: string, version: number, goal: ThreadGoal | null): boolean {
    if (!this.canHydrateThread(threadId) || (this.snapshot.goalVersionsByThread[threadId] ?? 0) !== version) return false;
    this.patch({ goalsByThread: put(this.snapshot.goalsByThread, threadId, { goal, stale: false }) });
    this.publish();
    return true;
  }
  failGoal(threadId: string, version: number, error: string): void {
    if (!this.canHydrateThread(threadId) || (this.snapshot.goalVersionsByThread[threadId] ?? 0) !== version) return;
    this.patch({ goalsByThread: put(this.snapshot.goalsByThread, threadId, { goal: this.snapshot.goalsByThread[threadId]?.goal ?? null, stale: true }) });
    this.record({ method: "thread/goal/cleared", params: { threadId } }, "目标刷新失败", error, "failed", keyOf("goal", threadId), threadId);
    this.publish();
  }
  hydrateProjects(version: number, entries: ProjectListResponse["data"]): boolean {
    if (!this.snapshot.connected || this.snapshot.projectVersion !== version) return false;
    this.patch({ projectsSnapshot: { version, status: "ready", entries: entries.slice(0, SERVER_EVENT_LIMITS.entities), truncated: entries.length > SERVER_EVENT_LIMITS.entities } });
    this.publish();
    return true;
  }
  failProjects(version: number, error: string): void {
    if (!this.snapshot.connected || this.snapshot.projectVersion !== version) return;
    this.patch({ projectsSnapshot: { ...this.snapshot.projectsSnapshot, version, status: "error", error: clipped(error) } });
    this.recordRefreshFailure("project/changed", error);
  }
  connect(): void {
    if (this.snapshot.connected) return;
    this.patch({ connected: true });
    this.publish();
  }
  private canHydrateThread(threadId: string): boolean {
    return this.snapshot.connected && !this.snapshot.deletedThreadIds.includes(threadId);
  }
  recordRefreshFailure(method: KnownServerNotificationMethod, error: string): void {
    this.saveRecord({ id: keyOf("refresh", method), method, title: "状态刷新失败", detail: clipped(error), status: "failed" });
    this.publish();
  }
  recordDiagnostic(diagnostic: Pick<RpcDiagnostic, "code" | "method">): void {
    const titles = { unknown_notification: "收到尚未支持的服务器通知", invalid_notification: "服务器通知格式无效", notification_handler_failed: "服务器通知处理失败" };
    if (!(diagnostic.code in titles)) return;
    const method = diagnostic.method !== undefined && isKnownServerNotificationMethod(diagnostic.method) ? diagnostic.method : undefined;
    const id = keyOf("diagnostic", diagnostic.code, method ?? "unknown");
    this.saveRecord({ id, method: "protocol/diagnostic", title: titles[diagnostic.code as keyof typeof titles], detail: method === undefined ? "请检查协议版本或连接诊断" : `${method} · 请检查连接诊断`, status: "warning" });
    this.publish();
  }
  completeCommand(processId: string, result: { exitCode: number; stdout: string; stderr: string }): void {
    this.completeProcess("command", processId, result);
    this.publish();
  }
  startProcess(kind: "command" | "process", id: string): void {
    for (const stream of ["stdout", "stderr"]) {
      this.decoders.delete(keyOf(kind, id, stream));
      this.streamed.delete(keyOf(kind, id, stream));
    }
    this.patch({ processes: put(this.snapshot.processes, keyOf(kind, id), { id, kind, status: "running", stdout: "", stderr: "", stdoutTruncated: false, stderrTruncated: false }) });
    this.publish();
  }
  failCommand(processId: string): void {
    this.failProcess("command", processId);
  }
  failProcess(kind: "command" | "process", processId: string): void {
    const id = keyOf(kind, processId);
    const previous = this.snapshot.processes[id];
    if (previous === undefined) return;
    const status = this.snapshot.connected ? "failed" : "unknown";
    this.patch({ processes: put(this.snapshot.processes, id, { ...previous, status }) });
    this.updateRecord(id, { status, detail: this.snapshot.connected ? "进程请求失败" : "连接已断开，进程结果未知" });
    for (const stream of ["stdout", "stderr"]) {
      this.decoders.delete(keyOf(kind, processId, stream));
      this.streamed.delete(keyOf(kind, processId, stream));
    }
    this.publish();
  }
  clear(): void {
    this.snapshot = initialSnapshot();
    this.decoders.clear();
    this.streamed.clear();
    this.publish();
  }
  disconnect(): void {
    if (!this.snapshot.connected) return;
    this.patch({
      connected: false,
      goalVersionsByThread: mapValues(this.snapshot.goalVersionsByThread, (version) => version + 1),
      projectVersion: this.snapshot.projectVersion + 1,
      projectsSnapshot: { ...this.snapshot.projectsSnapshot, status: "unknown" },
      records: this.snapshot.records.map((entry) => entry.status === "running" ? { ...entry, status: "unknown", detail: `${entry.detail}\n连接已断开，当前状态未知` } : entry),
      tokenUsageByThread: mapValues(this.snapshot.tokenUsageByThread, (entry) => ({ ...entry, stale: true })),
      goalsByThread: mapValues(this.snapshot.goalsByThread, (entry) => ({ ...entry, stale: true })),
      diffsByTurn: mapValues(this.snapshot.diffsByTurn, (entry) => ({ ...entry, stale: true })),
      queuesByThread: mapValues(this.snapshot.queuesByThread, (entry) => ({ ...entry, status: "unknown" })),
      queueVersionsByThread: mapValues(this.snapshot.queueVersionsByThread, (version) => version + 1),
      environmentsByThread: mapValues(this.snapshot.environmentsByThread, (entry) => ({ ...entry, status: "unknown" })),
      remoteControl: this.snapshot.remoteControl === null ? null : { ...this.snapshot.remoteControl, stale: true },
      searches: mapValues(this.snapshot.searches, (entry) => entry.status === "running" ? { ...entry, status: "unknown" } : entry),
      imports: mapValues(this.snapshot.imports, (entry) => entry.status === "running" ? { ...entry, status: "unknown" } : entry),
      processes: mapValues(this.snapshot.processes, (entry) => entry.status === "running" ? { ...entry, status: "unknown" } : entry),
      realtimeByThread: mapValues(this.snapshot.realtimeByThread, (entry) => ({ ...entry, status: entry.status === "running" ? "unknown" : entry.status, chunks: [], latestAudio: undefined, sdp: undefined })),
    });
    this.decoders.clear();
    this.streamed.clear();
    this.publish();
  }
  private patch(values: Partial<ServerEventSnapshot>): void { this.snapshot = { ...this.snapshot, ...values }; }
  private publish(): void { for (const listener of this.listeners) listener(); }
  private updateRecord(id: string, values: Partial<ServerEventRecord>): void {
    this.patch({ records: this.snapshot.records.map((entry) => entry.id === id ? { ...entry, ...values } : entry) });
  }
  private record(notification: ServerNotification, title: string, detail: string, status: ServerEventStatus, id = `event:${++this.serial}`, threadId?: string, turnId?: string, text?: string, includeParams = true): void {
    const params = includeParams ? JSON.stringify(notification.params, (key, value: unknown) => /token|password|secret|authorization|cookie|private.?key|api.?key|credential|ice.?pwd/iu.test(key) ? "[已隐藏]" : Array.isArray(value) ? value.slice(0, SERVER_EVENT_LIMITS.entities) : typeof value === "string" ? value.slice(0, SERVER_EVENT_LIMITS.details) : value, 2) : undefined;
    const previous = this.snapshot.records.find((entry) => entry.id === id);
    const record: ServerEventRecord = { id, method: notification.method, title, detail: clipped(detail, SERVER_EVENT_LIMITS.details), status, threadId, turnId, text: text === undefined ? undefined : clipped(text), params: params === undefined ? undefined : params.slice(0, SERVER_EVENT_LIMITS.details), truncated: (text?.length ?? 0) > SERVER_EVENT_LIMITS.text || detail.length > SERVER_EVENT_LIMITS.details || (params?.length ?? 0) > SERVER_EVENT_LIMITS.details || previous?.truncated === true };
    this.saveRecord(record);
  }
  private saveRecord(record: ServerEventRecord): void {
    const records = [...this.snapshot.records.filter((entry) => entry.id !== record.id), record];
    this.patch({ records: records.slice(-SERVER_EVENT_LIMITS.records), droppedRecords: this.snapshot.droppedRecords + Math.max(0, records.length - SERVER_EVENT_LIMITS.records) });
  }
  private finishThread(threadId: string, turnId?: string): void {
    this.patch({ records: this.snapshot.records.map((entry) => entry.threadId === threadId && (turnId === undefined || entry.turnId === turnId) && entry.status === "running" ? { ...entry, status: "unknown", detail: `${entry.detail}\n${turnId === undefined ? "会话订阅已关闭" : "回合已结束"}，未收到该活动的最终状态` } : entry) });
    if (turnId === undefined && this.snapshot.realtimeByThread[threadId]) this.patch({ realtimeByThread: put(this.snapshot.realtimeByThread, threadId, { ...this.snapshot.realtimeByThread[threadId], status: "unknown", latestAudio: undefined, sdp: undefined }) });
  }
  private clearThread(threadId: string): void {
    this.patch({ records: this.snapshot.records.filter((entry) => entry.threadId !== threadId), tokenUsageByThread: omit(this.snapshot.tokenUsageByThread, threadId), goalsByThread: omit(this.snapshot.goalsByThread, threadId), queueVersionsByThread: versionEntry(this.snapshot.queueVersionsByThread, threadId, (this.snapshot.queueVersionsByThread[threadId] ?? 0) + 1), goalVersionsByThread: versionEntry(this.snapshot.goalVersionsByThread, threadId, (this.snapshot.goalVersionsByThread[threadId] ?? 0) + 1), queuesByThread: omit(this.snapshot.queuesByThread, threadId), projectsByThread: omit(this.snapshot.projectsByThread, threadId), environmentsByThread: omit(this.snapshot.environmentsByThread, threadId), realtimeByThread: omit(this.snapshot.realtimeByThread, threadId), diffsByTurn: Object.fromEntries(Object.entries(this.snapshot.diffsByTurn).filter(([, value]) => value.threadId !== threadId)) });
  }
  private output(kind: "command" | "process", id: string, p: { stream: "stdout" | "stderr"; deltaBase64: string; capReached: boolean }, notification: ServerNotification): void {
    const key = keyOf(kind, id);
    const streamKey = keyOf(kind, id, p.stream);
    const decoder = this.decoders.get(streamKey) ?? new TextDecoder();
    this.decoders.set(streamKey, decoder);
    this.streamed.add(streamKey);
    const decoded = decoder.decode(base64Bytes(p.deltaBase64), { stream: !p.capReached });
    const existing = this.snapshot.processes[key];
    const previous = existing?.status === "running" ? existing : undefined;
    const next: ServerProcessState = { id, kind, status: "running", stdout: previous?.stdout ?? "", stderr: previous?.stderr ?? "", stdoutTruncated: previous?.stdoutTruncated ?? false, stderrTruncated: previous?.stderrTruncated ?? false };
    const output = next[p.stream] + decoded;
    const value = { ...next, [p.stream]: clipped(output), [`${p.stream}Truncated`]: next[`${p.stream}Truncated`] || p.capReached || output.length > SERVER_EVENT_LIMITS.text };
    this.patch({ processes: put(this.snapshot.processes, key, value) });
    this.record(notification, `${kind === "command" ? "命令" : "进程"} · ${id}`, "输出流正在接收", "running", key, undefined, undefined, `stdout\n${value.stdout}\nstderr\n${value.stderr}`, false);
    const retained = new Set(Object.values(this.snapshot.processes).flatMap((entry) => [keyOf(entry.kind, entry.id, "stdout"), keyOf(entry.kind, entry.id, "stderr")]));
    for (const key of this.decoders.keys()) if (!retained.has(key)) { this.decoders.delete(key); this.streamed.delete(key); }
  }
  private processExited(notification: Extract<ServerNotification, { method: "process/exited" }>): void {
    const p = notification.params;
    this.completeProcess("process", p.processHandle, p);
  }
  private completeProcess(kind: "command" | "process", id: string, p: { exitCode: number; stdout: string; stderr: string; stdoutCapReached?: boolean; stderrCapReached?: boolean }): void {
    const key = keyOf(kind, id);
    const previous = this.snapshot.processes[key];
    if (previous?.status === "completed" || previous?.status === "failed") return;
    const capture = (stream: "stdout" | "stderr"): string => {
      const streamKey = keyOf(kind, id, stream);
      const output = this.streamed.has(streamKey) ? (previous?.[stream] ?? "") + (this.decoders.get(streamKey)?.decode() ?? "") : p[stream];
      this.decoders.delete(streamKey);
      this.streamed.delete(streamKey);
      return output;
    };
    const stdout = capture("stdout");
    const stderr = capture("stderr");
    const value: ServerProcessState = { id, kind, status: p.exitCode === 0 ? "completed" : "failed", exitCode: p.exitCode, stdout: clipped(stdout), stderr: clipped(stderr), stdoutTruncated: p.stdoutCapReached === true || previous?.stdoutTruncated === true || stdout.length > SERVER_EVENT_LIMITS.text, stderrTruncated: p.stderrCapReached === true || previous?.stderrTruncated === true || stderr.length > SERVER_EVENT_LIMITS.text };
    this.patch({ processes: put(this.snapshot.processes, key, value) });
    this.saveRecord({ id: key, method: kind === "command" ? "command/exec/outputDelta" : "process/exited", title: `${kind === "command" ? "命令" : "进程"} · ${id}`, detail: `退出码 ${p.exitCode}`, status: value.status, text: clipped(`stdout\n${value.stdout}\nstderr\n${value.stderr}`), truncated: value.stdoutTruncated || value.stderrTruncated });
  }
  private realtime(notification: Extract<ServerNotification, { method: `thread/realtime/${string}` }>): void {
    const threadId = notification.params.threadId;
    let value = this.snapshot.realtimeByThread[threadId] ?? emptyRealtime();
    switch (notification.method) {
      case "thread/realtime/started":
        value = { ...emptyRealtime(), sessionId: notification.params.realtimeSessionId, version: notification.params.version };
        this.record(notification, "实时会话", "实时连接已建立", "running", keyOf("realtime", threadId), threadId);
        break;
      case "thread/realtime/itemAdded":
        this.record(notification, "实时会话条目", "收到实时会话内容", "info", undefined, threadId);
        break;
      case "thread/realtime/item/started":
      case "thread/realtime/item/completed": {
        const item = notification.params.item;
        const completed = notification.method === "thread/realtime/item/completed";
        const status = item.type === "realtimeSessionClosed" && item.outcome === "failed" ? "failed" : completed ? "completed" : "running";
        this.record(notification, "实时会话条目", item.type, status, keyOf("realtime-item", threadId, item.id), threadId, undefined, item.type === "transcriptSegment" ? item.text : undefined);
        break;
      }
      case "thread/realtime/item/transcript/delta": {
        const p = notification.params;
        const id = keyOf("realtime-item", threadId, p.itemId);
        const text = (this.snapshot.records.find((entry) => entry.id === id)?.text ?? "") + p.delta;
        this.record(notification, "实时会话条目", "transcriptSegment", "running", id, threadId, undefined, text, false);
        break;
      }
      case "thread/realtime/transcript/delta":
      case "thread/realtime/transcript/done": {
        const p = notification.params;
        const done = notification.method === "thread/realtime/transcript/done";
        const index = value.transcripts.findLastIndex((entry) => entry.role === p.role && !entry.completed);
        const previous = index < 0 ? undefined : value.transcripts[index];
        const text = notification.method === "thread/realtime/transcript/done" ? notification.params.text : (previous?.text ?? "") + notification.params.delta;
        const transcript = { role: p.role, text: clipped(text), completed: done, truncated: text.length > SERVER_EVENT_LIMITS.text || (!done && previous?.truncated === true) };
        const transcripts = [...value.transcripts];
        if (index < 0) transcripts.push(transcript); else transcripts[index] = transcript;
        value = { ...value, transcripts: transcripts.slice(-SERVER_EVENT_LIMITS.entities) };
        this.record(notification, "实时转写", `${p.role} · ${done ? "已完成" : "转写中"}`, done ? "completed" : "running", keyOf("transcript", threadId, p.role), threadId, undefined, text, false);
        break;
      }
      case "thread/realtime/outputAudio/delta": {
        const audio = notification.params.audio;
        const bytes = base64Bytes(audio.data).byteLength;
        const retained = bytes <= SERVER_EVENT_LIMITS.audioBytes;
        const previous = value.chunks.at(-1);
        const sameFormat = previous === undefined || (previous.sampleRate === audio.sampleRate && previous.numChannels === audio.numChannels && previous.itemId === audio.itemId);
        const chunks = retained ? [...(sameFormat ? value.chunks : []), audio] : [];
        let dropped = !sameFormat || !retained;
        let size = chunks.reduce((sum, chunk) => sum + base64ByteLength(chunk.data), 0);
        while (size > SERVER_EVENT_LIMITS.audioBytes || chunks.length > SERVER_EVENT_LIMITS.entities) {
          size -= base64ByteLength(chunks.shift()!.data);
          dropped = true;
        }
        value = { ...value, chunks, audioChunks: value.audioChunks + 1, audioBytes: value.audioBytes + bytes, audioTruncated: value.audioTruncated || dropped, latestAudio: retained ? audio : undefined };
        this.record(notification, "实时音频", `${value.audioChunks} 个音频片段 · ${value.audioBytes} 字节 · ${audio.sampleRate} Hz / ${audio.numChannels} 声道`, "running", keyOf("audio", threadId), threadId, undefined, undefined, false);
        break;
      }
      case "thread/realtime/sdp":
        value = { ...value, sdp: notification.params.sdp.slice(0, SERVER_EVENT_LIMITS.text) };
        this.record(notification, "实时连接协商", `已收到远端 SDP · ${notification.params.sdp.length} 字符`, "info", keyOf("sdp", threadId), threadId, undefined, undefined, false);
        break;
      case "thread/realtime/error":
        value = { ...value, status: "failed" };
        this.record(notification, "实时会话错误", notification.params.message, "failed", keyOf("realtime", threadId), threadId);
        break;
      case "thread/realtime/closed":
        value = { ...value, status: "completed", sdp: undefined };
        this.record(notification, "实时会话已关闭", notification.params.reason ?? "实时连接已结束", "completed", keyOf("realtime", threadId), threadId);
        this.patch({ records: this.snapshot.records.map((entry) => entry.threadId === threadId && entry.method.startsWith("thread/realtime/") && entry.status === "running" ? { ...entry, status: "unknown" } : entry) });
        break;
    }
    this.patch({ realtimeByThread: put(this.snapshot.realtimeByThread, threadId, value) });
  }
}

function base64Bytes(value: string): Uint8Array {
  return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
}

function base64ByteLength(value: string): number {
  return value.length * 3 / 4 - (value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0);
}
