import { useEffect, useState } from "react";

import type { RestoredThread, ThreadSummary, ThreadTurn } from "../app/useServerThreads";
import { Composer } from "../components/Composer";
import { ConnectionShell } from "../components/ConnectionShell";
import { ConversationView } from "../components/ConversationView";
import { ConversationWorkspace } from "../components/ConversationWorkspace";
import { RateLimitIndicator } from "../components/RateLimitIndicator";
import { SettingsDialog } from "../components/SettingsDialog";
import type { Model } from "../protocol/generated/types/ModelListResponse";
import { DEFAULT_APP_PREFERENCES, type PreferencesStore } from "../transport/preferences";
import type { VisualRegressionQuery } from "./visualRegressionQuery";

const NOOP_ASYNC = async () => undefined;
const NOOP_BOOLEAN = async () => true;

const MODELS = [
  {
    defaultReasoningEffort: "medium",
    description: "适合日常编码任务，兼顾速度与质量",
    displayName: "GPT-5",
    hidden: false,
    id: "gpt-5",
    isDefault: true,
    model: "gpt-5",
    supportedReasoningEfforts: [
      { description: "平衡速度与质量", reasoningEffort: "medium" },
      { description: "更深入地处理复杂任务", reasoningEffort: "high" },
    ],
  },
  {
    defaultReasoningEffort: "high",
    description: "适合大型代码库与复杂工程任务",
    displayName: "GPT-5 Pro",
    hidden: false,
    id: "gpt-5-pro",
    isDefault: false,
    model: "gpt-5-pro",
    supportedReasoningEfforts: [
      { description: "更深入地处理复杂任务", reasoningEffort: "high" },
    ],
  },
] satisfies readonly Model[];

const TURN = {
  durationMs: 18_400,
  id: "turn-visual-1",
  items: [
    {
      id: "user-visual-1",
      type: "userMessage",
      content: [{ type: "text", text: "请检查工作区中的改动，并修复测试失败的问题" }],
    },
    {
      id: "reasoning-visual-1",
      type: "reasoning",
      summary: ["我会先定位失败用例，再用最小改动修复并重新验证"],
    },
    {
      aggregatedOutput: "Test Files  73 passed\nTests  451 passed",
      command: "pnpm test",
      commandActions: [],
      cwd: "/workspace/codex-desktop-linux",
      exitCode: 0,
      id: "command-visual-1",
      status: "completed",
      type: "commandExecution",
    },
    {
      id: "agent-visual-1",
      phase: "final_answer",
      type: "agentMessage",
      text: "已经修复问题并完成验证。\n\n- 全量测试通过\n- 生产构建通过\n- 未改变项目外环境",
    },
  ],
  itemsView: "full",
  status: "completed",
} satisfies ThreadTurn;

const HISTORY_CONTENT = [
  ["检查测试失败的原因", "失败来自过期的快照，已经确认修复范围"],
  ["先查看相关实现", "我会检查消息流、活动组和现有测试"],
  ["修复后重新验证", "完成修改后会运行全量测试和生产构建"],
] as const;

const HISTORY_TURNS = HISTORY_CONTENT.map(([question, answer], index) => ({
  durationMs: 4_000 + index * 1_000,
  id: `turn-visual-history-${index + 1}`,
  items: [
    {
      content: [{ text: question, type: "text" as const }],
      id: `user-visual-history-${index + 1}`,
      type: "userMessage" as const,
    },
    {
      id: `agent-visual-history-${index + 1}`,
      phase: "final_answer" as const,
      text: answer,
      type: "agentMessage" as const,
    },
  ],
  itemsView: "full" as const,
  status: "completed" as const,
})) satisfies ThreadTurn[];

const VISUAL_TURNS = [...HISTORY_TURNS, TURN];

const RESTORED_THREAD = {
  metadata: createThread("thread-visual-1", "修复测试失败", 0, VISUAL_TURNS),
  nextCursor: null,
  turns: VISUAL_TURNS,
} satisfies RestoredThread;

const THREADS = [
  "修复测试失败",
  "完善 Linux 桌面集成",
  "检查 app-server 协议",
  "优化会话列表性能",
  "实现远程文件预览",
  "补充代理连接测试",
  "审查设置页交互",
  "整理发布说明",
  "排查连接恢复问题",
  "更新权限配置",
  "验证深色主题",
  "改进键盘导航",
].map((preview, index) => createThread(`thread-visual-${index + 1}`, preview, index)) satisfies readonly ThreadSummary[];

const VISUAL_PREFERENCES_STORE: PreferencesStore = {
  load: async () => DEFAULT_APP_PREFERENCES,
  save: async (preferences) => preferences,
  clearApplicationLogs: NOOP_ASYNC,
  clearTemporaryFiles: NOOP_ASYNC,
  clearAllLocalData: NOOP_ASYNC,
  readDiagnostics: async () => ({
    architecture: "x86_64",
    clientVersion: "0.1.0",
    desktop: "GNOME",
    operatingSystem: "Linux",
    protocolBaseline: "ac3da4fb1a2a",
    sessionType: "wayland",
    webviewVersion: "2.48.5",
  }),
};

export function VisualRegressionFixture({ state, theme }: VisualRegressionQuery) {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    return () => { delete document.documentElement.dataset.theme; };
  }, [theme]);

  useEffect(() => {
    setReady(false);
    const landmark = {
      conversation: "会话消息",
      slash: "输入建议",
      model: "选择模型",
      settings: "设置分区",
    }[state];
    let frame = 0;
    let readyTimer = 0;
    const reveal = () => {
      if (state === "model") {
        const button = document.querySelector<HTMLButtonElement>('button[aria-label="模型"]');
        if (button?.getAttribute("aria-expanded") !== "true") {
          button?.click();
        }
      }
      if (document.querySelector(`[aria-label="${landmark}"]`) !== null) {
        if (state === "conversation") {
          document
            .querySelector<HTMLButtonElement>('button[aria-label^="跳转到问题"]')
            ?.focus({ preventScroll: true });
          readyTimer = window.setTimeout(() => setReady(true), 240);
          return;
        }
        setReady(true);
        return;
      }
      frame = requestAnimationFrame(reveal);
    };
    frame = requestAnimationFrame(reveal);
    return () => {
      cancelAnimationFrame(frame);
      window.clearTimeout(readyTimer);
    };
  }, [state]);

  return (
    <div
      data-visual-ready={ready}
      data-visual-state={state}
      style={{ pointerEvents: "none" }}
    >
      <ConnectionShell
        contentSubtitle="本机 · /workspace/codex-desktop-linux"
        contentTitle="修复测试失败"
        currentThreadId="thread-visual-1"
        mainContent={(
          <ConversationWorkspace composer={<FixtureComposer state={state} />}>
            <ConversationView
              hasOlderTurns={false}
              loadingOlderTurns={false}
              onLoadOlderTurns={NOOP_ASYNC}
              restoredThread={RESTORED_THREAD}
            />
          </ConversationWorkspace>
        )}
        onNewTask={() => undefined}
        onOpenSettings={() => undefined}
        onOpenThread={() => undefined}
        phase="ready"
        threadListPhase="ready"
        threads={THREADS}
        topbarAccessory={(
          <RateLimitIndicator
            data={{
              rateLimits: { planType: "plus", primary: { usedPercent: 38 } },
              rateLimitsByLimitId: {
                codex: {
                  limitId: "codex",
                  limitName: "Codex",
                  planType: "plus",
                  primary: { resetsAt: 4_102_444_800, usedPercent: 38, windowDurationMins: 300 },
                },
              },
            }}
            error={null}
            loading={false}
            onRefresh={NOOP_ASYNC}
            refreshing={false}
            updatedAt={null}
          />
        )}
      />
      <SettingsDialog
        connectionPhase="ready"
        currentConnectionStage="app-server 初始化完成"
        currentServer={null}
        currentServerName="本机 Codex"
        notificationPermission="granted"
        onAllLocalDataCleared={() => undefined}
        onBeforeClearAllLocalData={NOOP_ASYNC}
        onClose={() => undefined}
        onDeleteProxy={() => undefined}
        onDeleteServer={() => undefined}
        onConnectServer={() => undefined}
        onEditProxy={() => undefined}
        onEditServer={() => undefined}
        onNewProxy={() => undefined}
        onNewServer={() => undefined}
        onOpenServerInNewWindow={() => undefined}
        onUpdatePreferences={() => undefined}
        open={state === "settings"}
        permissionProfiles={[]}
        preferences={{ ...DEFAULT_APP_PREFERENCES, theme }}
        preferencesError={null}
        preferencesLoading={false}
        preferencesSaving={false}
        preferencesStore={VISUAL_PREFERENCES_STORE}
        proxies={[]}
        recentConnectionError={null}
        servers={[]}
        serverConnectionViews={{}}
      />
    </div>
  );
}

function FixtureComposer({ state }: Pick<VisualRegressionQuery, "state">) {
  return (
    <Composer
      activeTurn={false}
      cwd="/workspace/codex-desktop-linux"
      error={null}
      initialText={state === "slash" ? "/" : ""}
      models={MODELS}
      onCwdChange={() => undefined}
      onSend={NOOP_BOOLEAN}
      onStop={NOOP_BOOLEAN}
      permissions={[
        { allowed: true, description: "可写当前工作区", id: ":workspace" },
        { allowed: true, description: "只读访问", id: ":read-only" },
      ]}
      showProjectPicker={true}
      stopping={false}
      submitting={false}
    />
  );
}

function createThread(
  id: string,
  preview: string,
  recencyIndex: number,
  turns: readonly ThreadTurn[] = [],
): ThreadSummary {
  return {
    cliVersion: "0.144.0",
    createdAt: 1_900_000_000 - recencyIndex * 3_600,
    cwd: recencyIndex % 3 === 0 ? "/workspace/codex-desktop-linux" : recencyIndex % 3 === 1 ? "/workspace/app-server" : "/workspace/design-system",
    ephemeral: false,
    id,
    modelProvider: "openai",
    preview,
    sessionId: `session-visual-${recencyIndex}`,
    source: "appServer",
    status: { type: "idle" },
    turns: [...turns],
    updatedAt: 1_900_000_000 - recencyIndex * 900,
  };
}
