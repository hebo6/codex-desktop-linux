import { useEffect, useMemo, useRef, useState } from "react";

import type { RestoredThread, ThreadTurn } from "../app/useServerThreads";
import { ConversationView } from "../components/ConversationView";
import { ConversationWorkspace } from "../components/ConversationWorkspace";

const NOOP_ASYNC = async () => undefined;
const TARGET_BLANK_SPACE = 160;

interface Geometry {
  readonly blankBelow: number;
  readonly headerTop: number;
  readonly scrollTop: number;
}

export function ActivityScrollReproduction() {
  const [fixtureKey, setFixtureKey] = useState(0);
  const [updateVersion, setUpdateVersion] = useState(0);
  const [geometry, setGeometry] = useState<Geometry | null>(null);
  const pageRef = useRef<HTMLDivElement>(null);
  const restoredThread = useMemo(
    () => createRestoredThread(updateVersion),
    [updateVersion],
  );

  useEffect(() => {
    document.documentElement.dataset.theme = "light";
    return () => {
      delete document.documentElement.dataset.theme;
    };
  }, []);

  useEffect(() => {
    let frame = 0;
    const timer = window.setTimeout(() => {
      frame = window.requestAnimationFrame(() => {
        const elements = reproductionElements(pageRef.current);
        if (elements === null) {
          return;
        }
        const { activityGroup, scroller } = elements;
        const groupBottom = activityGroup.getBoundingClientRect().bottom;
        const desiredBottom = scroller.getBoundingClientRect().bottom -
          TARGET_BLANK_SPACE;
        scroller.scrollTop += groupBottom - desiredBottom;
        scroller.dispatchEvent(new Event("scroll"));
        window.requestAnimationFrame(() => setGeometry(readGeometry(pageRef.current)));
      });
    }, 500);
    return () => {
      window.clearTimeout(timer);
      window.cancelAnimationFrame(frame);
    };
  }, [fixtureKey]);

  useEffect(() => {
    if (updateVersion === 0) {
      return;
    }
    const frame = window.requestAnimationFrame(() => {
      setGeometry(readGeometry(pageRef.current));
    });
    return () => window.cancelAnimationFrame(frame);
  }, [updateVersion]);

  const reset = () => {
    setGeometry(null);
    setUpdateVersion(0);
    setFixtureKey((current) => current + 1);
  };

  return (
    <div
      ref={pageRef}
      style={{
        background: "var(--color-content-bg)",
        display: "grid",
        gridTemplateRows: "auto minmax(0, 1fr)",
        height: "100vh",
      }}
    >
      <header
        style={{
          alignItems: "center",
          borderBottom: "1px solid var(--color-divider-subtle)",
          display: "flex",
          flexWrap: "wrap",
          gap: "12px",
          padding: "12px 20px",
        }}
      >
        <strong>活动项更新滚动复现</strong>
        <span style={{ color: "var(--color-text-secondary)", fontSize: 13 }}>
          初始状态下活动组下方保留约 {TARGET_BLANK_SPACE}px 空白，更新同一个活动项
        </span>
        <button
          disabled={updateVersion > 0}
          onClick={() => setUpdateVersion(1)}
          type="button"
        >
          更新正在进行的活动项
        </button>
        <button onClick={reset} type="button">重置</button>
        <output style={{ color: "var(--color-text-secondary)", fontSize: 13 }}>
          {geometry === null
            ? "正在定位"
            : `scrollTop ${Math.round(geometry.scrollTop)} · 活动组标题距顶部 ${Math.round(geometry.headerTop)}px · 下方空白 ${Math.round(geometry.blankBelow)}px`}
        </output>
      </header>
      <ConversationWorkspace
        composer={(
          <div
            style={{
              borderTop: "1px solid var(--color-divider-subtle)",
              color: "var(--color-text-tertiary)",
              minHeight: 88,
              padding: "20px 24px",
              textAlign: "center",
            }}
          >
            测试输入区
          </div>
        )}
      >
        <ConversationView
          hasOlderTurns={false}
          key={fixtureKey}
          loadingOlderTurns={false}
          onLoadOlderTurns={NOOP_ASYNC}
          restoredThread={restoredThread}
        />
      </ConversationWorkspace>
    </div>
  );
}

function reproductionElements(root: HTMLElement | null): {
  readonly activityGroup: HTMLElement;
  readonly activityHeader: HTMLButtonElement;
  readonly scroller: HTMLElement;
} | null {
  const scroller = root?.querySelector<HTMLElement>('[aria-label="会话消息"]') ??
    null;
  const activityHeader = Array.from(
    scroller?.querySelectorAll<HTMLButtonElement>("button[aria-expanded]") ?? [],
  ).find((button) => button.textContent?.startsWith("正在运行"));
  const activityGroup = activityHeader?.parentElement ?? null;
  return scroller === null || activityHeader === undefined || activityGroup === null
    ? null
    : { activityGroup, activityHeader, scroller };
}

function readGeometry(root: HTMLElement | null): Geometry | null {
  const elements = reproductionElements(root);
  if (elements === null) {
    return null;
  }
  const scrollerRect = elements.scroller.getBoundingClientRect();
  return {
    blankBelow: scrollerRect.bottom -
      elements.activityGroup.getBoundingClientRect().bottom,
    headerTop: elements.activityHeader.getBoundingClientRect().top - scrollerRect.top,
    scrollTop: elements.scroller.scrollTop,
  };
}

function createRestoredThread(updateVersion: number): RestoredThread {
  const activeTurn = {
    durationMs: updateVersion === 0 ? 2_400 : 4_800,
    id: "turn-activity-scroll-active",
    items: [
      {
        content: [{ text: "继续检查滚动行为", type: "text" }],
        id: "user-activity-scroll-active",
        type: "userMessage",
      },
      {
        id: "reasoning-activity-scroll-active",
        summary: updateVersion === 0
          ? ["正在核对活动组下方的可用空间"]
          : [
              "正在核对活动组下方的可用空间",
              "已确认下方仍有空间显示更新内容",
              "继续记录滚动位置变化",
            ],
        type: "reasoning",
      },
      {
        aggregatedOutput: "ConversationView.test.tsx\nConversationView.tsx",
        command: "rg -n scrollTop src/components/ConversationView.tsx",
        commandActions: [],
        cwd: "/workspace/codex-desktop-linux",
        durationMs: updateVersion === 0 ? 2_400 : 4_800,
        id: "command-activity-scroll-active",
        status: "inProgress",
        type: "commandExecution",
      },
    ],
    itemsView: "full",
    startedAt: 1_900_000_000,
    status: "inProgress",
  } satisfies ThreadTurn;
  const turns = [...HISTORY_TURNS, activeTurn];
  return {
    metadata: {
      cliVersion: "1.0.0",
      createdAt: 1_900_000_000,
      cwd: "/workspace/codex-desktop-linux",
      ephemeral: false,
      id: "thread-activity-scroll-reproduction",
      modelProvider: "openai",
      preview: "复现活动项更新滚动",
      sessionId: "session-activity-scroll-reproduction",
      source: "appServer",
      status: { type: "idle" },
      turns,
      updatedAt: 1_900_000_100,
    },
    modelSettings: { effort: "medium", model: "gpt-5", serviceTier: null },
    nextCursor: null,
    turns,
  };
}

const HISTORY_TURNS = Array.from({ length: 3 }, (_, index) => ({
  id: `turn-activity-scroll-history-${index}`,
  items: [
    {
      content: [{ text: `历史问题 ${index + 1}`, type: "text" as const }],
      id: `user-activity-scroll-history-${index}`,
      type: "userMessage" as const,
    },
    {
      id: `answer-activity-scroll-history-${index}`,
      phase: "final_answer" as const,
      text: [
        `这是第 ${index + 1} 条历史回答，用来形成稳定的滚动区域`,
        "",
        "页面会把最后一个活动组定位到视口下部",
      ].join("\n"),
      type: "agentMessage" as const,
    },
  ],
  itemsView: "full" as const,
  status: "completed" as const,
})) satisfies ThreadTurn[];
