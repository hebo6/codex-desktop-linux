import {
  act,
  createEvent,
  fireEvent,
  render as testingLibraryRender,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import type { ReactElement, ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { RestoredThread, ThreadTurn } from "../app/useServerThreads";
import { ConversationPlaceholder, ConversationView } from "./ConversationView";
import { ConversationWorkspace } from "./ConversationWorkspace";

const OriginalResizeObserver = globalThis.ResizeObserver;
const OriginalClientWidth = Object.getOwnPropertyDescriptor(
  HTMLElement.prototype,
  "clientWidth",
);
const OriginalScrollWidth = Object.getOwnPropertyDescriptor(
  HTMLElement.prototype,
  "scrollWidth",
);

function TestConversationWorkspace({ children }: { readonly children: ReactNode }) {
  return (
    <ConversationWorkspace
      composer={(
        <div
          aria-label="问题输入区边界"
          data-conversation-composer
          ref={(element) => {
            if (element === null) {
              return;
            }
            element.getBoundingClientRect = () => {
              const scroller = element.closest("[data-conversation-workspace]")
                ?.querySelector<HTMLElement>("[aria-label='会话消息']");
              const top = scroller === undefined || scroller === null
                ? 0
                : scroller.getBoundingClientRect().top +
                  scroller.clientHeight - 96;
              return {
                bottom: top + 96,
                height: 96,
                left: 0,
                right: 0,
                toJSON: () => ({}),
                top,
                width: 0,
                x: 0,
                y: top,
              };
            };
          }}
        />
      )}
    >
      {children}
    </ConversationWorkspace>
  );
}

function render(ui: ReactElement) {
  return testingLibraryRender(ui, { wrapper: TestConversationWorkspace });
}

function mockOverflowingTitle(text: string) {
  Object.defineProperties(HTMLElement.prototype, {
    clientWidth: {
      configurable: true,
      get() {
        return this.matches("[data-activity-title], [data-activity-title-line]") ? 80 : 0;
      },
    },
    scrollWidth: {
      configurable: true,
      get() {
        return this.textContent === text ? 160 : this.clientWidth;
      },
    },
  });
}

function mockElementBottom(element: HTMLElement, bottom: () => number) {
  element.getBoundingClientRect = () => {
    const edge = bottom();
    return {
      bottom: edge,
      height: 0,
      left: 0,
      right: 0,
      toJSON: () => ({}),
      top: edge,
      width: 0,
      x: 0,
      y: edge,
    };
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  Object.defineProperty(globalThis, "ResizeObserver", {
    configurable: true,
    value: OriginalResizeObserver,
  });
  if (OriginalClientWidth === undefined) {
    Reflect.deleteProperty(HTMLElement.prototype, "clientWidth");
  } else {
    Object.defineProperty(HTMLElement.prototype, "clientWidth", OriginalClientWidth);
  }
  if (OriginalScrollWidth === undefined) {
    Reflect.deleteProperty(HTMLElement.prototype, "scrollWidth");
  } else {
    Object.defineProperty(HTMLElement.prototype, "scrollWidth", OriginalScrollWidth);
  }
});

const TURN = {
  completedAt: new Date(2026, 6, 19, 12, 20).getTime() / 1_000,
  durationMs: 1_500,
  id: "turn-1",
  items: [
    { id: "user", type: "userMessage", content: [{ type: "text", text: "请检查项目" }] },
    { id: "hook", type: "hookPrompt", fragments: [{ hookRunId: "run-1", text: "项目指导" }] },
    { id: "commentary", phase: "commentary", type: "agentMessage", text: "我会先检查关键路径" },
    { id: "plan", type: "plan", text: "1. 检查\n2. 验证" },
    { id: "reasoning", type: "reasoning", summary: ["检查关键路径"] },
    {
      aggregatedOutput: "全部通过",
      command: "pnpm test",
      commandActions: [],
      cwd: "/workspace/project",
      exitCode: 0,
      id: "command",
      status: "completed",
      type: "commandExecution",
    },
    {
      changes: [{ diff: "+hello", kind: { type: "update" }, path: "src/App.tsx" }],
      id: "file",
      status: "completed",
      type: "fileChange",
    },
    {
      arguments: { token: "hidden", query: "safe" },
      id: "mcp",
      server: "docs",
      status: "completed",
      tool: "search",
      type: "mcpToolCall",
    },
    { arguments: {}, id: "dynamic", status: "completed", tool: "render", type: "dynamicToolCall" },
    {
      agentsStates: {},
      id: "collab",
      receiverThreadIds: [],
      senderThreadId: "thread-1",
      status: "completed",
      tool: "spawnAgent",
      type: "collabAgentToolCall",
    },
    {
      agentPath: "reviewer",
      agentThreadId: "thread-2",
      id: "subagent",
      kind: "started",
      type: "subAgentActivity",
    },
    { id: "search", query: "Codex 协议", type: "webSearch" },
    { id: "image", path: "/remote/result.png", type: "imageView" },
    { durationMs: 2_000, id: "sleep", type: "sleep" },
    { id: "generation", result: "生成完成", status: "completed", type: "imageGeneration" },
    { id: "review-in", review: "检查变更", type: "enteredReviewMode" },
    { id: "review-out", review: "没有问题", type: "exitedReviewMode" },
    { id: "compact", type: "contextCompaction" },
    { id: "agent", phase: "final_answer", type: "agentMessage", text: "已经完成检查" },
  ],
  itemsView: "full",
  startedAt: new Date(2026, 6, 19, 12, 19).getTime() / 1_000,
  status: "completed",
} satisfies ThreadTurn;

const RESTORED = {
  metadata: {
    cliVersion: "1.0.0",
    createdAt: 100,
    cwd: "/workspace/project",
    ephemeral: false,
    id: "thread-1",
    modelProvider: "openai",
    preview: "检查项目",
    sessionId: "session-1",
    source: "appServer",
    status: { type: "idle" },
    turns: [TURN],
    updatedAt: 200,
  },
  modelSettings: { effort: "medium", model: "gpt-5", serviceTier: null },
  nextCursor: "older",
  turns: [TURN],
} satisfies RestoredThread;

describe("ConversationView", () => {
  it("安全渲染用户问题 Markdown 并保留结构化输入", () => {
    const onOpenLink = vi.fn();
    const markdownTurn = {
      ...TURN,
      items: [
        {
          content: [
            {
              text: "# 检查范围\n\n**重点** [源码](src/App.tsx) <script>危险</script>",
              type: "text" as const,
            },
            { name: "README", path: "/workspace/README.md", type: "mention" as const },
          ],
          id: "user-markdown",
          type: "userMessage" as const,
        },
        { id: "answer-markdown", phase: "final_answer" as const, text: "收到", type: "agentMessage" as const },
      ],
    } satisfies ThreadTurn;

    render(
      <ConversationView
        hasOlderTurns={false}
        loadingOlderTurns={false}
        onLoadOlderTurns={vi.fn(async () => undefined)}
        onOpenLink={onOpenLink}
        restoredThread={{ ...RESTORED, nextCursor: null, turns: [markdownTurn] }}
      />,
    );

    expect(screen.getByRole("heading", { name: "检查范围" })).toBeVisible();
    expect(screen.getByText("重点")).toBeVisible();
    expect(screen.getByText("危险")).toBeVisible();
    expect(document.querySelector("script")).toBeNull();
    expect(screen.getByText("@README")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "源码" }));
    expect(onOpenLink).toHaveBeenCalledWith("src/App.tsx");
  });

  it("覆盖全部持久化 ThreadItem 的稳定展示", async () => {
    render(
      <ConversationView
        hasOlderTurns
        loadingOlderTurns={false}
        onLoadOlderTurns={vi.fn(async () => undefined)}
        restoredThread={RESTORED}
      />,
    );

    const activityGroups = screen.getAllByRole("button", { name: /已运行/u });
    expect(activityGroups).toHaveLength(1);
    expect(getComputedStyle(activityGroups[0]!).position).toBe("static");
    expect(screen.getByText("已经完成检查")).toBeVisible();
    expect(screen.queryByText("我会先检查关键路径")).not.toBeInTheDocument();
    for (const activityGroup of activityGroups) {
      expect(activityGroup).toHaveAttribute("aria-expanded", "false");
      fireEvent.click(activityGroup);
    }
    await waitFor(() => {
      for (const activityGroup of activityGroups) {
        expect(getComputedStyle(activityGroup).position).toBe("sticky");
        expect(getComputedStyle(activityGroup).top).toBe("0px");
      }
    });
    await waitFor(() => expect(screen.getByText("Hook 提示")).toBeVisible());
    fireEvent.click(screen.getByRole("button", { name: "Ran pnpm test" }));
    const commandHeading = screen.getByRole("button", { name: "Ran pnpm test" });
    await waitFor(() => {
      expect(getComputedStyle(commandHeading).position).toBe("sticky");
      expect(getComputedStyle(commandHeading).top).toBe("36px");
    });
    await waitFor(() => expect(screen.getByText("全部通过")).toBeVisible());

    await waitFor(() => {
      for (const text of [
        "请检查项目",
        "Hook 提示",
        "已经完成检查",
        "计划",
        "检查关键路径",
        "Ran pnpm test",
        "Updated",
        "src/App.tsx",
        "MCP · docs / search · 完成",
        "工具 · client / render · 完成",
        "协作代理 · spawnAgent · 完成",
        "子代理 · started · reviewer",
        "网页搜索 · Codex 协议",
        "查看图片 · /remote/result.png",
        "等待 · 2.0 秒",
        "图片生成 · 完成",
        "进入审查模式",
        "退出审查模式",
        "上下文已压缩",
      ]) {
        expect(screen.getByText(text)).toBeVisible();
      }
    });
    expect(screen.queryByText("hidden")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", {
      name: "MCP · docs / search · 完成",
    }));
    await waitFor(() => expect(screen.getByText(/••••••/u)).toBeVisible());
  });

  it("虚拟行使用 top 定位以支持活动粘性标题", async () => {
    render(
      <ConversationView
        hasOlderTurns={false}
        loadingOlderTurns={false}
        onLoadOlderTurns={vi.fn(async () => undefined)}
        restoredThread={{ ...RESTORED, nextCursor: null }}
      />,
    );
    const groupHeading = screen.getByRole("button", { name: /已运行/u });
    const virtualRow = groupHeading.closest<HTMLElement>("[data-virtual-key]");
    if (virtualRow === null) {
      throw new Error("缺少活动项虚拟行");
    }

    expect(virtualRow.style.top).toMatch(/^\d+px$/u);
    expect(virtualRow.style.transform).toBe("");
    fireEvent.click(groupHeading);
    expect(screen.getAllByRole("button", { name: /已运行/u })).toHaveLength(1);
    await waitFor(() => expect(getComputedStyle(groupHeading).position).toBe("sticky"));
  });

  it("活动粘性标题从内容区顶部依次排列", async () => {
    render(
      <ConversationView
        hasOlderTurns={false}
        loadingOlderTurns={false}
        onLoadOlderTurns={vi.fn(async () => undefined)}
        restoredThread={{ ...RESTORED, nextCursor: null }}
      />,
    );
    const activityGroup = screen.getByRole("button", { name: /已运行/u });
    fireEvent.click(activityGroup);
    await waitFor(() => {
      expect(getComputedStyle(activityGroup).position).toBe("sticky");
      expect(getComputedStyle(activityGroup).top).toBe("0px");
    });

    const commandHeading = await screen.findByRole("button", {
      name: "Ran pnpm test",
    });
    fireEvent.click(commandHeading);
    await waitFor(() => {
      expect(getComputedStyle(commandHeading).position).toBe("sticky");
      expect(getComputedStyle(commandHeading).top).toBe("36px");
    });
  });

  it("优先使用 commandActions 生成命令标题", async () => {
    mockOverflowingTitle("Ran pnpm test");
    const commandTurn = {
      durationMs: 2_000,
      id: "turn-command-actions",
      items: [
        {
          content: [{ text: "检查命令", type: "text" as const }],
          id: "user-command-actions",
          type: "userMessage" as const,
        },
        {
          aggregatedOutput: "匹配结果",
          command: "cat src/App.tsx && rg expanded src",
          commandActions: [
            {
              command: "cat src/App.tsx",
              name: "App.tsx",
              path: "/workspace/project/src/App.tsx",
              type: "read" as const,
            },
            {
              command: "rg expanded src",
              path: "src",
              query: "expanded",
              type: "search" as const,
            },
          ],
          cwd: "/workspace/project",
          id: "command-recognized",
          status: "completed" as const,
          type: "commandExecution" as const,
        },
        {
          command: "/usr/bin/bash -lc 'pnpm test'",
          commandActions: [{ command: "pnpm test", type: "unknown" as const }],
          cwd: "/workspace/project",
          id: "command-unknown",
          status: "completed" as const,
          type: "commandExecution" as const,
        },
        {
          id: "answer-command-actions",
          phase: "final_answer" as const,
          text: "命令检查完成",
          type: "agentMessage" as const,
        },
      ],
      itemsView: "full" as const,
      status: "completed" as const,
    } satisfies ThreadTurn;
    render(
      <ConversationView
        hasOlderTurns={false}
        loadingOlderTurns={false}
        onLoadOlderTurns={vi.fn(async () => undefined)}
        restoredThread={{ ...RESTORED, nextCursor: null, turns: [commandTurn] }}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /已运行/u }));
    const semanticCommand = await screen.findByRole("button", {
      name: "Read App.tsx · Searched “expanded” in src",
    });
    const rawCommand = await screen.findByRole("button", { name: "Ran pnpm test" });
    expect(semanticCommand).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(semanticCommand);
    await waitFor(() => expect(screen.getByText("匹配结果")).toBeVisible());
    expect(screen.queryByText("cat src/App.tsx && rg expanded src")).not.toBeInTheDocument();
    fireEvent.click(rawCommand);
    expect(rawCommand).toHaveAttribute("aria-expanded", "true");
    expect(rawCommand.closest("section")?.querySelector("[data-activity-detail]"))
      .not.toBeInTheDocument();
  });

  it("思考摘要逐行渲染并在存在内容或标题省略时支持展开", async () => {
    mockOverflowingTitle("仅有摘要");
    const onOpenLink = vi.fn();
    const reasoningTurn = {
      durationMs: 1_000,
      id: "turn-reasoning-disclosure",
      items: [
        {
          content: [{ text: "查看思考", type: "text" as const }],
          id: "user-reasoning-disclosure",
          type: "userMessage" as const,
        },
        {
          id: "reasoning-summary-only",
          summary: ["仅有摘要"],
          type: "reasoning" as const,
        },
        {
          id: "reasoning-short-summary",
          summary: ["短摘要"],
          type: "reasoning" as const,
        },
        {
          content: ["# 完整思考内容", "- 第一项\n- 第二项\n\n[资料](https://example.com/reasoning)"],
          id: "reasoning-with-content",
          summary: ["**分析**", "`关键路径`"],
          type: "reasoning" as const,
        },
        {
          content: ["没有摘要的思考内容"],
          id: "reasoning-content-only",
          type: "reasoning" as const,
        },
        {
          id: "answer-reasoning-disclosure",
          phase: "final_answer" as const,
          text: "思考检查完成",
          type: "agentMessage" as const,
        },
      ],
      itemsView: "full" as const,
      status: "completed" as const,
    } satisfies ThreadTurn;
    render(
      <ConversationView
        hasOlderTurns={false}
        loadingOlderTurns={false}
        onLoadOlderTurns={vi.fn(async () => undefined)}
        onOpenLink={onOpenLink}
        restoredThread={{ ...RESTORED, nextCursor: null, turns: [reasoningTurn] }}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /已运行/u }));
    await waitFor(() => expect(screen.getByText("仅有摘要")).toBeVisible());
    expect(screen.queryByRole("button", { name: "短摘要" })).not.toBeInTheDocument();
    const summaryOnly = await screen.findByRole("button", { name: "仅有摘要" });
    fireEvent.click(summaryOnly);
    expect(summaryOnly).toHaveAttribute("aria-expanded", "true");
    expect(summaryOnly.closest("section")?.querySelector("[data-activity-detail]"))
      .not.toBeInTheDocument();
    const summarizedReasoning = screen.getByRole("button", { name: "分析 关键路径" });
    expect(within(summarizedReasoning).getByText("分析").tagName).toBe("STRONG");
    expect(within(summarizedReasoning).getByText("关键路径").tagName).toBe("CODE");
    expect(summarizedReasoning.querySelectorAll("[data-activity-title-line]")).toHaveLength(2);
    expect(screen.getByRole("button", { name: "Thinking" })).toBeVisible();
    fireEvent.click(summarizedReasoning);
    await waitFor(() => expect(screen.getByRole("heading", { name: "完整思考内容" })).toBeVisible());
    const reasoningDetail = screen.getByRole("heading", {
      name: "完整思考内容",
    }).closest<HTMLElement>("[data-activity-detail]");
    if (reasoningDetail === null) {
      throw new Error("缺少思考活动详情");
    }
    expect(within(reasoningDetail).queryByText("分析")).not.toBeInTheDocument();
    expect(within(reasoningDetail).queryByText("关键路径")).not.toBeInTheDocument();
    expect(screen.getByText("第一项").closest("ul")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "资料" }));
    expect(onOpenLink).toHaveBeenCalledWith("https://example.com/reasoning");
  });

  it("文件变更按文件显示状态、完整路径入口和增删行数", async () => {
    const onOpenDiff = vi.fn();
    const movedDiff = "--- a/src/from.ts\n+++ b/src/to.ts\n-old\n+new";
    const fileTurn = {
      durationMs: 1_000,
      id: "turn-file-changes",
      items: [
        {
          content: [{ text: "修改文件", type: "text" as const }],
          id: "user-file-changes",
          type: "userMessage" as const,
        },
        {
          changes: [
            { diff: "one\ntwo\n", kind: { type: "add" as const }, path: "src/new.ts" },
            {
              diff: "--- a/src/existing.ts\n+++ b/src/existing.ts\n-old\n+new",
              kind: { type: "update" as const },
              path: "src/existing.ts",
            },
            { diff: "gone\n", kind: { type: "delete" as const }, path: "src/old.ts" },
            {
              diff: movedDiff,
              kind: { move_path: "src/to.ts", type: "update" as const },
              path: "src/from.ts",
            },
            {
              diff: "GIT binary patch",
              kind: { type: "update" as const },
              path: "assets/result.png",
            },
          ],
          id: "file-changes",
          status: "completed" as const,
          type: "fileChange" as const,
        },
        {
          id: "answer-file-changes",
          phase: "final_answer" as const,
          text: "文件修改完成",
          type: "agentMessage" as const,
        },
      ],
      itemsView: "full" as const,
      status: "completed" as const,
    } satisfies ThreadTurn;
    render(
      <ConversationView
        hasOlderTurns={false}
        loadingOlderTurns={false}
        onOpenDiff={onOpenDiff}
        onLoadOlderTurns={vi.fn(async () => undefined)}
        restoredThread={{ ...RESTORED, nextCursor: null, turns: [fileTurn] }}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /已运行/u }));
    const added = await screen.findByRole("button", { name: "Added src/new.ts +2" });
    expect(added).not.toHaveAttribute("aria-expanded");
    expect(screen.getByRole("button", {
      name: "Updated src/existing.ts +1 −1",
    })).toBeVisible();
    expect(screen.getByRole("button", { name: "Deleted src/old.ts −1" })).toBeVisible();
    expect(screen.getByRole("button", {
      name: "Updated assets/result.png",
    })).toBeVisible();
    const moved = screen.getByRole("button", {
      name: "Moved src/from.ts → src/to.ts +1 −1",
    });
    fireEvent.click(moved);
    expect(onOpenDiff).toHaveBeenCalledWith("src/to.ts", movedDiff);
  });

  it("最终回答开始时自动折叠已工作活动组", async () => {
    const runningTurn = {
      ...TURN,
      completedAt: null,
      items: TURN.items.filter(
        (item) => item.type !== "agentMessage" || item.phase !== "final_answer",
      ),
      status: "inProgress" as const,
    };
    const runningThread = {
      ...RESTORED,
      metadata: { ...RESTORED.metadata, turns: [runningTurn] },
      turns: [runningTurn],
    } satisfies RestoredThread;
    const { rerender } = render(
      <ConversationView
        hasOlderTurns={false}
        loadingOlderTurns={false}
        onLoadOlderTurns={vi.fn(async () => undefined)}
        restoredThread={runningThread}
      />,
    );

    for (const activityGroup of screen.getAllByRole("button", { name: /正在运行/u })) {
      expect(activityGroup).toHaveAttribute("aria-expanded", "true");
    }

    const finalAnswerTurn = {
      ...runningTurn,
      items: TURN.items,
    } satisfies ThreadTurn;
    rerender(
      <ConversationView
        hasOlderTurns={false}
        loadingOlderTurns={false}
        onLoadOlderTurns={vi.fn(async () => undefined)}
        restoredThread={{ ...RESTORED, nextCursor: null, turns: [finalAnswerTurn] }}
      />,
    );

    await waitFor(() => {
      for (const activityGroup of screen.getAllByRole("button", { name: /已运行/u })) {
        expect(activityGroup).toHaveAttribute("aria-expanded", "false");
      }
    });
    expect(screen.getByText("已经完成检查")).toBeVisible();
    await waitFor(() =>
      expect(screen.queryByText("我会先检查关键路径")).not.toBeInTheDocument(),
    );
  });

  it("在底部展开已完成活动组后不再因行高变化自动贴底", () => {
    const { rerender } = render(
      <ConversationView
        hasOlderTurns={false}
        loadingOlderTurns={false}
        onLoadOlderTurns={vi.fn(async () => undefined)}
        restoredThread={{ ...RESTORED, nextCursor: null }}
      />,
    );
    const scroller = screen.getByLabelText("会话消息");
    let scrollHeight = 1_000;
    Object.defineProperties(scroller, {
      clientHeight: { configurable: true, value: 200 },
      scrollHeight: { configurable: true, get: () => scrollHeight },
    });
    scroller.scrollTop = 800;
    fireEvent.scroll(scroller);

    fireEvent.click(screen.getByRole("button", { name: /已运行/u }));

    const expandedTurn = {
      ...TURN,
      items: TURN.items.flatMap((item) => item.id === "hook"
        ? [
            item,
            {
              id: "commentary-after-hook",
              phase: "commentary" as const,
              text: "继续检查",
              type: "agentMessage" as const,
            },
          ]
        : [item]),
    } satisfies ThreadTurn;
    scrollHeight = 1_400;
    rerender(
      <ConversationView
        hasOlderTurns={false}
        loadingOlderTurns={false}
        onLoadOlderTurns={vi.fn(async () => undefined)}
        restoredThread={{ ...RESTORED, nextCursor: null, turns: [expandedTurn] }}
      />,
    );

    expect(scroller.scrollTop).toBe(800);
  });

  it("按会话内容末尾和回答可读区判断是否已在底部", () => {
    render(
      <ConversationView
        hasOlderTurns={false}
        loadingOlderTurns={false}
        onLoadOlderTurns={vi.fn(async () => undefined)}
        restoredThread={{ ...RESTORED, nextCursor: null }}
      />,
    );
    const scroller = screen.getByLabelText("会话消息");
    const tail = scroller.querySelector<HTMLElement>("[data-conversation-tail]");
    if (tail === null) {
      throw new Error("缺少会话内容末尾标记");
    }
    let tailBottom = 380;
    Object.defineProperties(scroller, {
      clientHeight: { configurable: true, value: 500 },
      scrollHeight: { configurable: true, value: 1_500 },
    });
    mockElementBottom(tail, () => tailBottom);

    fireEvent.scroll(scroller);
    expect(screen.queryByRole("button", { name: "回到底部" }))
      .not.toBeInTheDocument();

    tailBottom = 381;
    fireEvent.scroll(scroller);
    expect(screen.getByRole("button", { name: "回到底部" })).toBeVisible();
  });

  it("手动向末尾滚动时不越过实际会话内容末尾", () => {
    render(
      <ConversationView
        hasOlderTurns={false}
        loadingOlderTurns={false}
        onLoadOlderTurns={vi.fn(async () => undefined)}
        restoredThread={{ ...RESTORED, nextCursor: null }}
      />,
    );
    const scroller = screen.getByLabelText("会话消息");
    const tail = scroller.querySelector<HTMLElement>("[data-conversation-tail]");
    if (tail === null) {
      throw new Error("缺少会话内容末尾标记");
    }
    Object.defineProperties(scroller, {
      clientHeight: { configurable: true, value: 500 },
      scrollHeight: { configurable: true, value: 1_500 },
    });
    const tailDocumentBottom = 900;
    mockElementBottom(tail, () => tailDocumentBottom - scroller.scrollTop);

    scroller.scrollTop = 100;
    fireEvent.wheel(scroller);
    scroller.scrollTop = 600;
    fireEvent.scroll(scroller);
    expect(scroller.scrollTop).toBe(520);

    const forwardWheel = createEvent.wheel(scroller, { deltaY: 120 });
    fireEvent(scroller, forwardWheel);
    expect(forwardWheel.defaultPrevented).toBe(true);

    scroller.scrollTop = 620;
    fireEvent.scroll(scroller);
    expect(scroller.scrollTop).toBe(520);

    fireEvent.wheel(scroller);
    scroller.scrollTop = 300;
    fireEvent.scroll(scroller);
    expect(scroller.scrollTop).toBe(300);
  });

  it("手动滚动停止后保留位置并在后续内容越界时恢复跟随", () => {
    vi.useFakeTimers();
    const earlierTurn = {
      id: "turn-bottom-1",
      items: [
        {
          content: [{ text: "第一条问题", type: "text" as const }],
          id: "user-bottom-1",
          type: "userMessage" as const,
        },
        {
          id: "answer-bottom-1",
          phase: "final_answer" as const,
          text: "第一条回答",
          type: "agentMessage" as const,
        },
      ],
      itemsView: "full" as const,
      status: "completed" as const,
    } satisfies ThreadTurn;
    const activeTurn = {
      id: "turn-bottom-2",
      items: [
        {
          content: [{ text: "最近一个问题", type: "text" as const }],
          id: "user-bottom-2",
          type: "userMessage" as const,
        },
        {
          id: "answer-bottom-2",
          text: "正在回答",
          type: "agentMessage" as const,
        },
      ],
      itemsView: "full" as const,
      status: "inProgress" as const,
    } satisfies ThreadTurn;
    const activeThread = {
      ...RESTORED,
      nextCursor: null,
      turns: [earlierTurn, activeTurn],
    } satisfies RestoredThread;
    const { rerender } = render(
      <ConversationView
        hasOlderTurns={false}
        loadingOlderTurns={false}
        onLoadOlderTurns={vi.fn(async () => undefined)}
        restoredThread={activeThread}
      />,
    );
    const scroller = screen.getByLabelText("会话消息");
    const tail = scroller.querySelector<HTMLElement>("[data-conversation-tail]");
    if (tail === null) {
      throw new Error("缺少会话内容末尾标记");
    }
    Object.defineProperties(scroller, {
      clientHeight: { configurable: true, value: 500 },
      scrollHeight: { configurable: true, value: 1_600 },
    });
    let tailDocumentBottom = 480;
    mockElementBottom(tail, () => tailDocumentBottom - scroller.scrollTop);

    scroller.scrollTop = 100;
    fireEvent.wheel(scroller);
    fireEvent.scroll(scroller);
    expect(screen.queryByRole("button", { name: "回到底部" }))
      .not.toBeInTheDocument();

    act(() => vi.advanceTimersByTime(300));
    expect(scroller.scrollTop).toBe(100);

    tailDocumentBottom = 850;
    rerender(
      <ConversationView
        hasOlderTurns={false}
        loadingOlderTurns={false}
        onLoadOlderTurns={vi.fn(async () => undefined)}
        restoredThread={{
          ...activeThread,
          turns: [
            earlierTurn,
            {
              ...activeTurn,
              items: activeTurn.items.map((item) =>
                item.id === "answer-bottom-2"
                  ? { ...item, text: "正在回答，内容继续增长" }
                  : item
              ),
            },
          ],
        }}
      />,
    );

    expect(scroller.scrollTop).toBe(480);
  });

  it("思考项目没有摘要时显示占位，工具到达后不保留占位", async () => {
    const thinkingTurn = {
      id: "turn-thinking",
      items: [
        { id: "user-thinking", type: "userMessage", content: [{ type: "text", text: "继续分析" }] },
        { id: "reasoning-thinking", type: "reasoning" },
      ],
      itemsView: "full",
      startedAt: Date.now() / 1_000 - 5,
      status: "inProgress",
    } satisfies ThreadTurn;
    const { rerender } = render(
      <ConversationView
        hasOlderTurns={false}
        loadingOlderTurns={false}
        onLoadOlderTurns={vi.fn(async () => undefined)}
        restoredThread={{ ...RESTORED, nextCursor: null, turns: [thinkingTurn] }}
      />,
    );

    expect(screen.getByText("Thinking")).toBeVisible();

    const commandTurn = {
      ...thinkingTurn,
      items: [
        ...thinkingTurn.items,
        {
          aggregatedOutput: "处理中",
          command: "pnpm test",
          commandActions: [],
          cwd: "/workspace/project",
          durationMs: 12_000,
          id: "command-running",
          status: "inProgress",
          type: "commandExecution",
        },
      ],
    } satisfies ThreadTurn;
    rerender(
      <ConversationView
        hasOlderTurns={false}
        loadingOlderTurns={false}
        onLoadOlderTurns={vi.fn(async () => undefined)}
        restoredThread={{ ...RESTORED, nextCursor: null, turns: [commandTurn] }}
      />,
    );

    expect(screen.queryByText("Thinking")).not.toBeInTheDocument();
    expect(screen.getByText("正在运行命令 · 12 秒")).toBeVisible();
    expect(screen.queryByText("处理中")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Running pnpm test" }));
    await waitFor(() => expect(screen.getByText("处理中")).toBeVisible());
  });

  it("用户停止后保留最终回答并以中性标题冻结耗时", () => {
    const interruptedTurn = {
      durationMs: 10_000,
      id: "turn-interrupted",
      items: [
        { id: "user-interrupted", type: "userMessage", content: [{ type: "text", text: "执行计划" }] },
        { id: "commentary-interrupted", phase: "commentary", type: "agentMessage", text: "正在准备执行" },
        { id: "answer-interrupted", phase: "final_answer", type: "agentMessage", text: "计划已制定" },
      ],
      itemsView: "full",
      status: "interrupted",
    } satisfies ThreadTurn;

    render(
      <ConversationView
        hasOlderTurns={false}
        loadingOlderTurns={false}
        onLoadOlderTurns={vi.fn(async () => undefined)}
        restoredThread={{ ...RESTORED, nextCursor: null, turns: [interruptedTurn] }}
      />,
    );

    expect(screen.getByRole("button", { name: "已停止 10 秒" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    expect(screen.getByText("计划已制定")).toBeVisible();
    expect(screen.queryByText("正在准备执行")).not.toBeInTheDocument();
  });

  it("用户问题达到四个时显示预览并跳转到对应问题", () => {
    const turns = Array.from({ length: 4 }, (_, index) => ({
      durationMs: 1_000,
      id: `turn-question-${index + 1}`,
      items: [
        {
          content: [{ text: `问题 ${index + 1}`, type: "text" as const }],
          id: `user-question-${index + 1}`,
          type: "userMessage" as const,
        },
        {
          id: `answer-question-${index + 1}`,
          phase: "final_answer" as const,
          text: `回答 ${index + 1}`,
          type: "agentMessage" as const,
        },
      ],
      itemsView: "full" as const,
      status: "completed" as const,
    })) satisfies ThreadTurn[];
    render(
      <ConversationView
        hasOlderTurns={false}
        loadingOlderTurns={false}
        onLoadOlderTurns={vi.fn(async () => undefined)}
        restoredThread={{ ...RESTORED, nextCursor: null, turns }}
      />,
    );

    const navigation = screen.getByRole("navigation", { name: "历史问题快速导航" });
    const firstMarker = screen.getByRole("button", { name: "跳转到问题 1：问题 1" });
    expect(navigation).toContainElement(firstMarker);
    expect(firstMarker).toHaveTextContent("问题 1");
    expect(firstMarker).toHaveTextContent("回答 1");

    const scroller = screen.getByLabelText("会话消息");
    Object.defineProperty(scroller, "clientHeight", { configurable: true, value: 200 });
    const tail = scroller.querySelector<HTMLElement>("[data-conversation-tail]");
    if (tail === null) {
      throw new Error("缺少会话内容末尾标记");
    }
    mockElementBottom(tail, () => 1_200 - scroller.scrollTop);
    scroller.scrollTop = 900;
    fireEvent.click(firstMarker);
    expect(scroller.scrollTop).toBe(24);
    expect(screen.getByRole("button", { name: "回到底部" })).toBeVisible();
  });

  it("滚动回答时不渲染问题的粘性副本", () => {
    const turns = Array.from({ length: 3 }, (_, index) => ({
      id: `turn-sticky-${index + 1}`,
      items: [
        {
          content: [{ text: `历史问题 ${index + 1}`, type: "text" as const }],
          id: `user-sticky-${index + 1}`,
          type: "userMessage" as const,
        },
        {
          id: `answer-sticky-${index + 1}`,
          phase: "final_answer" as const,
          text: `历史回答 ${index + 1}`,
          type: "agentMessage" as const,
        },
      ],
      itemsView: "full" as const,
      status: "completed" as const,
    })) satisfies ThreadTurn[];
    render(
      <ConversationView
        hasOlderTurns={false}
        loadingOlderTurns={false}
        onLoadOlderTurns={vi.fn(async () => undefined)}
        restoredThread={{ ...RESTORED, nextCursor: null, turns }}
      />,
    );
    const scroller = screen.getByLabelText("会话消息");
    scroller.scrollTop = 100;
    fireEvent.scroll(scroller);
    scroller.scrollTop = 320;
    fireEvent.scroll(scroller);
    expect(screen.getAllByText("历史问题 1")).toHaveLength(1);
    expect(screen.getAllByText("历史问题 2")).toHaveLength(1);
    expect(scroller.parentElement?.querySelector("[data-sticky-question]"))
      .not.toBeInTheDocument();
  });

  it("已有可读空白时首个流式回答不应将新问题滚动到顶部", () => {
    const completedTurn = {
      id: "turn-blank-space-1",
      items: [
        {
          content: [{ text: "较短的历史问题", type: "text" as const }],
          id: "user-blank-space-1",
          type: "userMessage" as const,
        },
        {
          id: "answer-blank-space-1",
          phase: "final_answer" as const,
          text: "较短的历史回答",
          type: "agentMessage" as const,
        },
      ],
      itemsView: "full" as const,
      status: "completed" as const,
    } satisfies ThreadTurn;
    const { rerender } = render(
      <ConversationView
        hasOlderTurns={false}
        loadingOlderTurns={false}
        onLoadOlderTurns={vi.fn(async () => undefined)}
        restoredThread={{ ...RESTORED, nextCursor: null, turns: [completedTurn] }}
      />,
    );
    const scroller = screen.getByLabelText("会话消息");
    let scrollTop = 0;
    let maximumScrollTop = 0;
    Object.defineProperties(scroller, {
      clientHeight: { configurable: true, value: 800 },
      scrollTop: {
        configurable: true,
        get: () => scrollTop,
        set: (value: number) => {
          scrollTop = Math.min(value, maximumScrollTop);
        },
      },
    });
    const activeQuestion = {
      id: "turn-blank-space-2",
      items: [
        {
          content: [{ text: "新问题", type: "text" as const }],
          id: "user-blank-space-2",
          type: "userMessage" as const,
        },
      ],
      itemsView: "full" as const,
      status: "inProgress" as const,
    } satisfies ThreadTurn;

    rerender(
      <ConversationView
        hasOlderTurns={false}
        loadingOlderTurns={false}
        onLoadOlderTurns={vi.fn(async () => undefined)}
        restoredThread={{
          ...RESTORED,
          nextCursor: null,
          turns: [completedTurn, activeQuestion],
        }}
      />,
    );

    expect(scroller.scrollTop).toBe(0);
    const conversationTail = scroller.querySelector<HTMLElement>(
      "[data-conversation-tail]",
    );
    if (conversationTail === null) {
      throw new Error("缺少会话内容末尾标记");
    }
    mockElementBottom(conversationTail, () => 520 - scroller.scrollTop);
    maximumScrollTop = 1_000;

    rerender(
      <ConversationView
        hasOlderTurns={false}
        loadingOlderTurns={false}
        onLoadOlderTurns={vi.fn(async () => undefined)}
        restoredThread={{
          ...RESTORED,
          nextCursor: null,
          turns: [
            completedTurn,
            {
              ...activeQuestion,
              items: [
                ...activeQuestion.items,
                {
                  id: "answer-blank-space-2",
                  text: "开始流式回答",
                  type: "agentMessage" as const,
                },
              ],
            },
          ],
        }}
      />,
    );

    expect(scroller.scrollTop).toBe(0);
  });

  it("活动项更新先使用下方可见空白，实际越界后仅滚动溢出距离", () => {
    const activeTurn = {
      durationMs: 1_000,
      id: "turn-activity-following",
      items: [
        {
          content: [{ text: "检查活动滚动", type: "text" as const }],
          id: "user-activity-following",
          type: "userMessage" as const,
        },
        {
          id: "reasoning-activity-following",
          summary: ["正在检查可见空白"],
          type: "reasoning" as const,
        },
      ],
      itemsView: "full" as const,
      status: "inProgress" as const,
    } satisfies ThreadTurn;
    const activeThread = {
      ...RESTORED,
      nextCursor: null,
      turns: [activeTurn],
    } satisfies RestoredThread;
    const { rerender } = render(
      <ConversationView
        hasOlderTurns={false}
        loadingOlderTurns={false}
        onLoadOlderTurns={vi.fn(async () => undefined)}
        restoredThread={activeThread}
      />,
    );
    const scroller = screen.getByLabelText("会话消息");
    const conversationTail = scroller.querySelector<HTMLElement>(
      "[data-conversation-tail]",
    );
    if (conversationTail === null) {
      throw new Error("缺少会话内容末尾标记");
    }
    Object.defineProperties(scroller, {
      clientHeight: { configurable: true, value: 500 },
      scrollHeight: { configurable: true, value: 1_500 },
    });
    let tailDocumentBottom = 460;
    mockElementBottom(
      conversationTail,
      () => tailDocumentBottom - scroller.scrollTop,
    );
    scroller.scrollTop = 100;
    fireEvent.scroll(scroller);

    rerender(
      <ConversationView
        hasOlderTurns={false}
        loadingOlderTurns={false}
        onLoadOlderTurns={vi.fn(async () => undefined)}
        restoredThread={{
          ...activeThread,
          turns: [{ ...activeTurn, durationMs: 2_000 }],
        }}
      />,
    );

    expect(scroller.scrollTop).toBe(100);
    expect(screen.queryByRole("button", { name: "回到底部" }))
      .not.toBeInTheDocument();

    tailDocumentBottom = 510;
    rerender(
      <ConversationView
        hasOlderTurns={false}
        loadingOlderTurns={false}
        onLoadOlderTurns={vi.fn(async () => undefined)}
        restoredThread={{
          ...activeThread,
          turns: [{ ...activeTurn, durationMs: 3_000 }],
        }}
      />,
    );

    expect(scroller.scrollTop).toBe(150);
    expect(screen.queryByRole("button", { name: "回到底部" }))
      .not.toBeInTheDocument();
  });

  it("进行中的活动回到底部时以实际内容末尾为目标", () => {
    const activeTurn = {
      id: "turn-activity-jump",
      items: [
        {
          content: [{ text: "检查活动位置", type: "text" as const }],
          id: "user-activity-jump",
          type: "userMessage" as const,
        },
        {
          id: "reasoning-activity-jump",
          summary: ["正在检查回到底部"],
          type: "reasoning" as const,
        },
      ],
      itemsView: "full" as const,
      status: "inProgress" as const,
    } satisfies ThreadTurn;
    const { rerender } = render(
      <ConversationView
        hasOlderTurns={false}
        loadingOlderTurns={false}
        onLoadOlderTurns={vi.fn(async () => undefined)}
        restoredThread={{ ...RESTORED, nextCursor: null, turns: [activeTurn] }}
      />,
    );
    const scroller = screen.getByLabelText("会话消息");
    const composer = screen.getByLabelText("问题输入区边界");
    const conversationTail = scroller.querySelector<HTMLElement>(
      "[data-conversation-tail]",
    );
    if (conversationTail === null) {
      throw new Error("缺少会话内容末尾标记");
    }
    Object.defineProperties(scroller, {
      clientHeight: { configurable: true, value: 500 },
      scrollHeight: { configurable: true, value: 2_000 },
    });
    let tailDocumentBottom = 1_300;
    mockElementBottom(
      conversationTail,
      () => tailDocumentBottom - scroller.scrollTop,
    );
    scroller.scrollTop = 100;
    fireEvent.wheel(scroller, { deltaY: -120 });
    fireEvent.scroll(scroller);

    fireEvent.click(screen.getByRole("button", { name: "回到底部" }));

    expect(scroller.scrollTop).toBe(920);
    expect(
      composer.getBoundingClientRect().top -
        conversationTail.getBoundingClientRect().bottom,
    ).toBe(24);
    expect(screen.queryByRole("button", { name: "回到底部" }))
      .not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /正在运行/u })).toBeVisible();

    tailDocumentBottom = 1_350;
    rerender(
      <ConversationView
        hasOlderTurns={false}
        loadingOlderTurns={false}
        onLoadOlderTurns={vi.fn(async () => undefined)}
        restoredThread={{
          ...RESTORED,
          nextCursor: null,
          turns: [{ ...activeTurn, durationMs: 1_000 }],
        }}
      />,
    );

    expect(scroller.scrollTop).toBe(990);
    expect(
      composer.getBoundingClientRect().top -
        conversationTail.getBoundingClientRect().bottom,
    ).toBe(44);
    expect(screen.queryByRole("button", { name: "回到底部" }))
      .not.toBeInTheDocument();
  });

  it("进行中的回答回到底部后不被输入区遮挡", () => {
    const activeTurn = {
      id: "turn-answer-composer",
      items: [
        {
          content: [{ text: "继续回答", type: "text" as const }],
          id: "user-answer-composer",
          type: "userMessage" as const,
        },
        {
          id: "answer-composer",
          text: "输入区上方的最新 AI 回答",
          type: "agentMessage" as const,
        },
      ],
      itemsView: "full" as const,
      status: "inProgress" as const,
    } satisfies ThreadTurn;
    render(
      <ConversationView
        hasOlderTurns={false}
        loadingOlderTurns={false}
        onLoadOlderTurns={vi.fn(async () => undefined)}
        restoredThread={{ ...RESTORED, nextCursor: null, turns: [activeTurn] }}
      />,
    );
    const scroller = screen.getByLabelText("会话消息");
    const composer = screen.getByLabelText("问题输入区边界");
    const conversationTail = scroller.querySelector<HTMLElement>(
      "[data-conversation-tail]",
    );
    if (conversationTail === null) {
      throw new Error("缺少会话内容末尾标记");
    }
    Object.defineProperties(scroller, {
      clientHeight: { configurable: true, value: 500 },
      scrollHeight: { configurable: true, value: 2_000 },
    });
    const tailDocumentBottom = 1_300;
    mockElementBottom(
      conversationTail,
      () => tailDocumentBottom - scroller.scrollTop,
    );
    scroller.scrollTop = 100;
    fireEvent.wheel(scroller, { deltaY: -120 });
    fireEvent.scroll(scroller);

    fireEvent.click(screen.getByRole("button", { name: "回到底部" }));

    const contentBottom = conversationTail.getBoundingClientRect().bottom;
    const composerTop = composer.getBoundingClientRect().top;
    expect(scroller.scrollTop).toBe(920);
    expect(composerTop - contentBottom).toBe(24);
    expect(screen.getByText("输入区上方的最新 AI 回答")).toBeVisible();
  });

  it("进行中的长会话可访问全部历史 AI 回答并回到最新回答", async () => {
    class FakeResizeObserver {
      constructor(_callback: ResizeObserverCallback) {}
      disconnect() {}
      observe() {}
      unobserve() {}
    }
    Object.defineProperty(globalThis, "ResizeObserver", {
      configurable: true,
      value: FakeResizeObserver,
    });
    const originalBoundingRect = HTMLElement.prototype.getBoundingClientRect;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect")
      .mockImplementation(function (this: HTMLElement) {
        if (!this.matches("[data-virtual-key]")) {
          return originalBoundingRect.call(this);
        }
        const height = this.dataset.virtualKey?.includes(":segment:user-")
          ? 96
          : 180;
        return {
          bottom: height,
          height,
          left: 0,
          right: 0,
          toJSON: () => ({}),
          top: 0,
          width: 0,
          x: 0,
          y: 0,
        };
      });
    const historyTurns = Array.from({ length: 20 }, (_, index) => ({
      id: `turn-ai-history-${index}`,
      items: [
        {
          content: [{ text: `历史问题 ${index}`, type: "text" as const }],
          id: `user-ai-history-${index}`,
          type: "userMessage" as const,
        },
        {
          id: `answer-ai-history-${index}`,
          phase: "final_answer" as const,
          text: `历史 AI 回答 ${index}`,
          type: "agentMessage" as const,
        },
      ],
      itemsView: "full" as const,
      status: "completed" as const,
    })) satisfies ThreadTurn[];
    const activeTurn = {
      id: "turn-ai-active",
      items: [
        {
          content: [{ text: "继续生成回答", type: "text" as const }],
          id: "user-ai-active",
          type: "userMessage" as const,
        },
        {
          id: "commentary-ai-active",
          phase: "commentary" as const,
          text: "当前 AI 进度",
          type: "agentMessage" as const,
        },
        {
          id: "answer-ai-active",
          text: "当前最新 AI 回答",
          type: "agentMessage" as const,
        },
      ],
      itemsView: "full" as const,
      status: "inProgress" as const,
    } satisfies ThreadTurn;
    render(
      <ConversationView
        hasOlderTurns={false}
        loadingOlderTurns={false}
        onLoadOlderTurns={vi.fn(async () => undefined)}
        restoredThread={{
          ...RESTORED,
          metadata: { ...RESTORED.metadata, id: "thread-ai-scrolling" },
          nextCursor: null,
          turns: [...historyTurns, activeTurn],
        }}
      />,
    );
    const scroller = screen.getByLabelText("会话消息");
    const conversationTail = scroller.querySelector<HTMLElement>(
      "[data-conversation-tail]",
    );
    if (conversationTail === null) {
      throw new Error("缺少会话内容末尾标记");
    }
    let scrollTop = 0;
    Object.defineProperties(scroller, {
      clientHeight: { configurable: true, value: 240 },
      scrollHeight: { configurable: true, value: 7_000 },
      scrollTop: {
        configurable: true,
        get: () => scrollTop,
        set: (value: number) => {
          scrollTop = value;
        },
      },
    });
    const tailDocumentBottom = 6_000;
    mockElementBottom(
      conversationTail,
      () => tailDocumentBottom - scroller.scrollTop,
    );

    await waitFor(() => expect(scroller.scrollTop).toBe(6_760));
    fireEvent.wheel(scroller, { deltaY: -120 });
    const visibleHistoryAnswers = new Set<string>();
    historyTurns.forEach((_turn, index) => {
      scroller.scrollTop = index * 276;
      fireEvent.scroll(scroller);
      const answer = `历史 AI 回答 ${index}`;
      const answerRow = scroller.querySelector<HTMLElement>(
        `[data-virtual-key="turn-ai-history-${index}:segment:answer-ai-history-${index}"]`,
      );
      expect(answerRow).not.toBeNull();
      expect(within(answerRow!).getByText(answer)).toBeVisible();
      visibleHistoryAnswers.add(answer);
    });
    expect(visibleHistoryAnswers.size).toBe(20);

    scroller.scrollTop = 0;
    fireEvent.scroll(scroller);
    fireEvent.click(screen.getByRole("button", { name: "回到底部" }));
    expect(scroller.scrollTop).toBe(5_880);
    fireEvent.scroll(scroller);

    expect(screen.getByText("当前 AI 进度")).toBeVisible();
    expect(screen.getByText("当前最新 AI 回答")).toBeVisible();
    expect(screen.queryByRole("button", { name: "回到底部" }))
      .not.toBeInTheDocument();
  });

  it("新问题离散翻页并在手动滚动延时后重新判断跟随", () => {
    const firstTurn = {
      id: "turn-page-1",
      items: [
        {
          content: [{ text: "分页问题 1", type: "text" as const }],
          id: "user-page-1",
          type: "userMessage" as const,
        },
        {
          id: "answer-page-1",
          phase: "final_answer" as const,
          text: "分页回答 1",
          type: "agentMessage" as const,
        },
      ],
      itemsView: "full" as const,
      status: "completed" as const,
    } satisfies ThreadTurn;
    const { rerender } = render(
      <ConversationView
        hasOlderTurns={false}
        loadingOlderTurns={false}
        onLoadOlderTurns={vi.fn(async () => undefined)}
        restoredThread={{ ...RESTORED, nextCursor: null, turns: [firstTurn] }}
      />,
    );
    const scroller = screen.getByLabelText("会话消息");
    Object.defineProperties(scroller, {
      clientHeight: { configurable: true, value: 500 },
      scrollHeight: { configurable: true, value: 1_720 },
    });
    const conversationTail = scroller.querySelector<HTMLElement>(
      "[data-conversation-tail]",
    );
    if (conversationTail === null) {
      throw new Error("缺少会话内容末尾标记");
    }
    let tailDocumentBottom = 600;
    mockElementBottom(
      conversationTail,
      () => tailDocumentBottom - scroller.scrollTop,
    );
    const activeTurn = {
      id: "turn-page-2",
      items: [
        {
          content: [{ text: "分页问题 2", type: "text" as const }],
          id: "user-page-2",
          type: "userMessage" as const,
        },
        {
          id: "answer-page-2",
          text: "正在流式回答",
          type: "agentMessage" as const,
        },
      ],
      itemsView: "full" as const,
      status: "inProgress" as const,
    } satisfies ThreadTurn;
    const activeThread = {
      ...RESTORED,
      nextCursor: null,
      turns: [firstTurn, activeTurn],
    } satisfies RestoredThread;
    rerender(
      <ConversationView
        hasOlderTurns={false}
        loadingOlderTurns={false}
        onLoadOlderTurns={vi.fn(async () => undefined)}
        restoredThread={activeThread}
      />,
    );

    expect(scroller.scrollTop).toBe(300);

    tailDocumentBottom = 850;
    rerender(
      <ConversationView
        hasOlderTurns={false}
        loadingOlderTurns={false}
        onLoadOlderTurns={vi.fn(async () => undefined)}
        restoredThread={{ ...activeThread, turns: [firstTurn, { ...activeTurn }] }}
      />,
    );

    expect(scroller.scrollTop).toBe(680);

    vi.useFakeTimers();
    scroller.scrollTop = 100;
    fireEvent.wheel(scroller);
    fireEvent.scroll(scroller);
    rerender(
      <ConversationView
        hasOlderTurns={false}
        loadingOlderTurns={false}
        onLoadOlderTurns={vi.fn(async () => undefined)}
        restoredThread={{ ...activeThread, turns: [firstTurn, { ...activeTurn }] }}
      />,
    );
    expect(scroller.scrollTop).toBe(100);
    expect(screen.getByRole("button", { name: "回到底部" })).toBeVisible();

    scroller.scrollTop = 470;
    fireEvent.wheel(scroller);
    fireEvent.scroll(scroller);
    expect(screen.queryByRole("button", { name: "回到底部" }))
      .not.toBeInTheDocument();

    tailDocumentBottom = 1_200;
    rerender(
      <ConversationView
        hasOlderTurns={false}
        loadingOlderTurns={false}
        onLoadOlderTurns={vi.fn(async () => undefined)}
        restoredThread={{ ...activeThread, turns: [firstTurn, { ...activeTurn }] }}
      />,
    );
    expect(scroller.scrollTop).toBe(470);
    expect(screen.getByRole("button", { name: "回到底部" })).toBeVisible();

    act(() => vi.advanceTimersByTime(300));
    rerender(
      <ConversationView
        hasOlderTurns={false}
        loadingOlderTurns={false}
        onLoadOlderTurns={vi.fn(async () => undefined)}
        restoredThread={{ ...activeThread, turns: [firstTurn, { ...activeTurn }] }}
      />,
    );
    expect(scroller.scrollTop).toBe(470);

    scroller.scrollTop = 700;
    fireEvent.wheel(scroller);
    fireEvent.scroll(scroller);
    act(() => vi.advanceTimersByTime(200));
    fireEvent.wheel(scroller);
    fireEvent.scroll(scroller);
    act(() => vi.advanceTimersByTime(100));

    tailDocumentBottom = 1_550;
    rerender(
      <ConversationView
        hasOlderTurns={false}
        loadingOlderTurns={false}
        onLoadOlderTurns={vi.fn(async () => undefined)}
        restoredThread={{ ...activeThread, turns: [firstTurn, { ...activeTurn }] }}
      />,
    );
    expect(scroller.scrollTop).toBe(700);
    expect(screen.getByRole("button", { name: "回到底部" })).toBeVisible();

    scroller.scrollTop = 1_170;
    fireEvent.wheel(scroller);
    fireEvent.scroll(scroller);
    act(() => vi.advanceTimersByTime(300));

    tailDocumentBottom = 1_600;
    rerender(
      <ConversationView
        hasOlderTurns={false}
        loadingOlderTurns={false}
        onLoadOlderTurns={vi.fn(async () => undefined)}
        restoredThread={{ ...activeThread, turns: [firstTurn, { ...activeTurn }] }}
      />,
    );
    expect(scroller.scrollTop).toBe(1_220);
    expect(screen.queryByRole("button", { name: "回到底部" }))
      .not.toBeInTheDocument();
  });

  it("新问题首次定位受限时在回答到达后重试", () => {
    const firstTurn = {
      id: "turn-position-1",
      items: [
        {
          content: [{ text: "较早问题", type: "text" as const }],
          id: "user-position-1",
          type: "userMessage" as const,
        },
        {
          id: "answer-position-1",
          phase: "final_answer" as const,
          text: "较早回答",
          type: "agentMessage" as const,
        },
      ],
      itemsView: "full" as const,
      status: "completed" as const,
    } satisfies ThreadTurn;
    const { rerender } = render(
      <ConversationView
        hasOlderTurns={false}
        loadingOlderTurns={false}
        onLoadOlderTurns={vi.fn(async () => undefined)}
        restoredThread={{ ...RESTORED, nextCursor: null, turns: [firstTurn] }}
      />,
    );
    const scroller = screen.getByLabelText("会话消息");
    let scrollTop = 0;
    let maximumScrollTop = 250;
    Object.defineProperty(scroller, "scrollTop", {
      configurable: true,
      get: () => scrollTop,
      set: (value: number) => {
        scrollTop = Math.min(value, maximumScrollTop);
      },
    });
    Object.defineProperty(scroller, "clientHeight", {
      configurable: true,
      value: 500,
    });
    const conversationTail = scroller.querySelector<HTMLElement>(
      "[data-conversation-tail]",
    );
    if (conversationTail === null) {
      throw new Error("缺少会话内容末尾标记");
    }
    mockElementBottom(
      conversationTail,
      () => 650 - scroller.scrollTop,
    );
    const activeQuestion = {
      id: "turn-position-2",
      items: [
        {
          content: [{ text: "正在回答的问题", type: "text" as const }],
          id: "user-position-2",
          type: "userMessage" as const,
        },
      ],
      itemsView: "full" as const,
      status: "inProgress" as const,
    } satisfies ThreadTurn;

    rerender(
      <ConversationView
        hasOlderTurns={false}
        loadingOlderTurns={false}
        onLoadOlderTurns={vi.fn(async () => undefined)}
        restoredThread={{
          ...RESTORED,
          nextCursor: null,
          turns: [firstTurn, activeQuestion],
        }}
      />,
    );

    maximumScrollTop = 1_000;
    rerender(
      <ConversationView
        hasOlderTurns={false}
        loadingOlderTurns={false}
        onLoadOlderTurns={vi.fn(async () => undefined)}
        restoredThread={{
          ...RESTORED,
          nextCursor: null,
          turns: [
            firstTurn,
            {
              ...activeQuestion,
              items: [
                ...activeQuestion.items,
                {
                  id: "answer-position-2",
                  text: "回答开始生成",
                  type: "agentMessage" as const,
                },
              ],
            },
          ],
        }}
      />,
    );

    expect(scroller.scrollTop).toBe(300);
  });

  it("从回答所在 turn 发起分叉并标记最新回合", () => {
    const onForkTurn = vi.fn();
    render(
      <ConversationView
        hasOlderTurns={false}
        loadingOlderTurns={false}
        onForkTurn={onForkTurn}
        onLoadOlderTurns={vi.fn(async () => undefined)}
        restoredThread={RESTORED}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "在新会话中继续" }));
    expect(onForkTurn).toHaveBeenCalledWith("turn-1", true);
  });

  it("消息操作使用图标并按消息状态显示时间点", () => {
    const turns = [
      {
        completedAt: new Date(2026, 6, 19, 12, 10).getTime() / 1_000,
        durationMs: 5_000,
        id: "turn-history",
        items: [
          {
            content: [{ text: "历史问题", type: "text" as const }],
            id: "user-history",
            type: "userMessage" as const,
          },
          {
            id: "answer-history",
            phase: "final_answer" as const,
            text: "历史回答",
            type: "agentMessage" as const,
          },
        ],
        itemsView: "full" as const,
        startedAt: new Date(2026, 6, 19, 12, 9).getTime() / 1_000,
        status: "completed" as const,
      },
      {
        completedAt: new Date(2026, 6, 19, 12, 20).getTime() / 1_000,
        durationMs: 5_000,
        id: "turn-latest",
        items: [
          {
            content: [{ text: "最新问题", type: "text" as const }],
            id: "user-latest",
            type: "userMessage" as const,
          },
          {
            id: "answer-latest",
            phase: "final_answer" as const,
            text: "最新回答",
            type: "agentMessage" as const,
          },
        ],
        itemsView: "full" as const,
        startedAt: new Date(2026, 6, 19, 12, 19).getTime() / 1_000,
        status: "completed" as const,
      },
    ] satisfies ThreadTurn[];
    render(
      <ConversationView
        hasOlderTurns={false}
        loadingOlderTurns={false}
        onForkTurn={vi.fn()}
        onLoadOlderTurns={vi.fn(async () => undefined)}
        restoredThread={{ ...RESTORED, nextCursor: null, turns }}
      />,
    );

    const historicalAnswer = screen.getByText("历史回答").closest("article")!;
    const latestAnswer = screen.getByText("最新回答").closest("article")!;
    const historicalQuestion = screen.getByText("历史问题").closest("article")!;
    const historicalQuestionCopy = within(historicalQuestion).getByRole("button", {
      name: "复制用户消息",
    });
    const historicalCopy = within(historicalAnswer).getByRole("button", {
      name: "复制 AI 回答",
    });
    const latestCopy = within(latestAnswer).getByRole("button", {
      name: "复制 AI 回答",
    });
    const latestContinue = within(latestAnswer).getByRole("button", {
      name: "在新会话中继续",
    });
    const historicalQuestionTime = within(historicalQuestion).getByText("2026-07-19 12:09");
    const historicalTime = within(historicalAnswer).getByText("2026-07-19 12:10");
    const latestTime = within(latestAnswer).getByText("2026-07-19 12:20");
    const latestCopyTooltip = within(latestCopy).getByText("复制");
    const latestContinueTooltip = within(latestContinue).getByText("在新会话中继续");


    expect(historicalAnswer).toHaveAttribute("data-latest-turn", "false");
    expect(latestAnswer).toHaveAttribute("data-latest-turn", "true");
    expect(historicalQuestionCopy).not.toBeVisible();
    expect(historicalQuestionTime).not.toBeVisible();
    expect(historicalCopy).not.toBeVisible();
    expect(latestCopy).toBeVisible();
    expect(latestContinue).toBeVisible();
    expect(historicalTime).not.toBeVisible();
    expect(latestTime).not.toBeVisible();
    expect(latestCopy.querySelector("svg")).toBeInTheDocument();
    expect(latestContinue.querySelector("svg")).toBeInTheDocument();
    expect(latestCopyTooltip).not.toBeVisible();
    expect(latestContinueTooltip).not.toBeVisible();
    expect(historicalQuestionTime.parentElement?.previousElementSibling).toContainElement(
      screen.getByText("历史问题"),
    );

    historicalAnswer.focus();
    expect(historicalAnswer).toHaveFocus();
  });

  it("通过顶部入口加载更早回合", () => {
    const onLoadOlderTurns = vi.fn(async () => undefined);
    render(
      <ConversationView
        hasOlderTurns
        loadingOlderTurns={false}
        onLoadOlderTurns={onLoadOlderTurns}
        restoredThread={RESTORED}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "加载更早历史" }));
    expect(onLoadOlderTurns).toHaveBeenCalledTimes(1);
  });

  it("长消息流只挂载视口附近内容", () => {
    class FakeResizeObserver {
      constructor(_callback: ResizeObserverCallback) {}
      disconnect() {}
      observe() {}
      unobserve() {}
    }
    Object.defineProperty(globalThis, "ResizeObserver", {
      configurable: true,
      value: FakeResizeObserver,
    });
    const longTurn = {
      ...TURN,
      items: Array.from({ length: 1_000 }, (_, index) => ({
        id: `agent-${index}`,
        text: `回答 ${index}`,
        type: "agentMessage" as const,
      })),
    } satisfies ThreadTurn;
    const longThread = {
      ...RESTORED,
      metadata: { ...RESTORED.metadata, turns: [longTurn] },
      nextCursor: null,
      turns: [longTurn],
    } satisfies RestoredThread;

    render(
      <ConversationView
        hasOlderTurns={false}
        loadingOlderTurns={false}
        onLoadOlderTurns={vi.fn(async () => undefined)}
        restoredThread={longThread}
      />,
    );

    expect(screen.getAllByText(/回答 \d+/u).length).toBeLessThan(100);
  });

  it("从侧边栏加载未虚拟化会话后等待真实行高再定位到底部", async () => {
    class FakeResizeObserver {
      constructor(_callback: ResizeObserverCallback) {}
      disconnect() {}
      observe() {}
      unobserve() {}
    }
    Object.defineProperty(globalThis, "ResizeObserver", {
      configurable: true,
      value: FakeResizeObserver,
    });
    const originalBoundingRect = HTMLElement.prototype.getBoundingClientRect;
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get")
      .mockImplementation(function (this: HTMLElement) {
        return this.getAttribute("aria-label") === "会话消息" ? 240 : 0;
      });
    vi.spyOn(HTMLElement.prototype, "scrollHeight", "get")
      .mockImplementation(function (this: HTMLElement) {
        if (this.getAttribute("aria-label") !== "会话消息") {
          return 0;
        }
        const list = this.querySelector<HTMLElement>("[data-conversation-list]");
        return Number.parseFloat(list?.style.height ?? "0") + 148;
      });
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect")
      .mockImplementation(function (this: HTMLElement) {
        if (!this.matches("[data-virtual-key]")) {
          return originalBoundingRect.call(this);
        }
        const height = this.textContent?.includes("很长的历史回答") ? 720 : 70;
        return {
          bottom: height,
          height,
          left: 0,
          right: 0,
          toJSON: () => ({}),
          top: 0,
          width: 0,
          x: 0,
          y: 0,
        };
      });
    const turn = {
      id: "turn-short-loaded",
      items: [
        {
          content: [{ text: "历史问题", type: "text" as const }],
          id: "user-short-loaded",
          type: "userMessage" as const,
        },
        {
          id: "answer-short-loaded",
          phase: "final_answer" as const,
          text: "很长的历史回答",
          type: "agentMessage" as const,
        },
      ],
      itemsView: "full" as const,
      status: "completed" as const,
    } satisfies ThreadTurn;
    const loadedThread = {
      ...RESTORED,
      metadata: {
        ...RESTORED.metadata,
        id: "thread-short-loaded",
        turns: [turn],
      },
      nextCursor: null,
      turns: [turn],
    } satisfies RestoredThread;
    const { rerender } = render(<ConversationPlaceholder kind="loading" />);

    rerender(
      <ConversationView
        hasOlderTurns={false}
        loadingOlderTurns={false}
        onLoadOlderTurns={vi.fn(async () => undefined)}
        restoredThread={loadedThread}
      />,
    );

    const scroller = screen.getByLabelText("会话消息");
    expect(scroller.querySelectorAll("[data-virtual-key]")).toHaveLength(2);
    await waitFor(() =>
      expect(scroller.scrollTop).toBe(
        scroller.scrollHeight - scroller.clientHeight,
      ),
    );
  });

  it("从侧边栏加载长会话后定位到已测量内容的底部", async () => {
    class FakeResizeObserver {
      constructor(_callback: ResizeObserverCallback) {}
      disconnect() {}
      observe() {}
      unobserve() {}
    }
    Object.defineProperty(globalThis, "ResizeObserver", {
      configurable: true,
      value: FakeResizeObserver,
    });
    const originalBoundingRect = HTMLElement.prototype.getBoundingClientRect;
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get")
      .mockImplementation(function (this: HTMLElement) {
        return this.getAttribute("aria-label") === "会话消息" ? 240 : 0;
      });
    vi.spyOn(HTMLElement.prototype, "scrollHeight", "get")
      .mockImplementation(function (this: HTMLElement) {
        if (this.getAttribute("aria-label") !== "会话消息") {
          return 0;
        }
        const list = this.querySelector<HTMLElement>("[data-conversation-list]");
        return Number.parseFloat(list?.style.height ?? "0") + 148;
      });
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect")
      .mockImplementation(function (this: HTMLElement) {
        if (!this.matches("[data-virtual-key]")) {
          return originalBoundingRect.call(this);
        }
        const height = this.textContent?.includes("历史回答 19") ? 420 : 70;
        return {
          bottom: height,
          height,
          left: 0,
          right: 0,
          toJSON: () => ({}),
          top: 0,
          width: 0,
          x: 0,
          y: 0,
        };
      });
    const turns = Array.from({ length: 20 }, (_, index) => ({
      id: `turn-loaded-${index}`,
      items: [
        {
          content: [{ text: `历史问题 ${index}`, type: "text" as const }],
          id: `user-loaded-${index}`,
          type: "userMessage" as const,
        },
        {
          id: `answer-loaded-${index}`,
          phase: "final_answer" as const,
          text: `历史回答 ${index}`,
          type: "agentMessage" as const,
        },
      ],
      itemsView: "full" as const,
      status: "completed" as const,
    })) satisfies ThreadTurn[];
    const loadedThread = {
      ...RESTORED,
      metadata: { ...RESTORED.metadata, id: "thread-loaded", turns },
      nextCursor: null,
      turns,
    } satisfies RestoredThread;
    const { rerender } = render(<ConversationPlaceholder kind="loading" />);

    rerender(
      <ConversationView
        hasOlderTurns={false}
        loadingOlderTurns={false}
        onLoadOlderTurns={vi.fn(async () => undefined)}
        restoredThread={loadedThread}
      />,
    );

    const scroller = screen.getByLabelText("会话消息");
    await waitFor(() =>
      expect(scroller.querySelector(
        '[data-virtual-key="turn-loaded-19:segment:answer-loaded-19"]',
      )).not.toBeNull(),
    );
    await waitFor(() =>
      expect(scroller.scrollTop).toBe(
        scroller.scrollHeight - scroller.clientHeight,
      ),
    );
  });

  it("区分空白、加载和错误主区状态", () => {
    const { rerender } = render(<ConversationPlaceholder kind="blank" />);
    expect(screen.getByRole("status")).toHaveTextContent("发送第一条消息时才会创建");
    rerender(<ConversationPlaceholder kind="loading" />);
    expect(screen.getByRole("status")).toHaveTextContent("正在恢复会话");
    rerender(<ConversationPlaceholder kind="error" />);
    expect(screen.getByRole("alert")).toHaveTextContent("无法恢复会话");
    const onNewTask = vi.fn();
    rerender(
      <ConversationPlaceholder kind="deleted" onNewTask={onNewTask} />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent("不能继续提交输入");
    fireEvent.click(screen.getByRole("button", { name: "返回新建页" }));
    expect(onNewTask).toHaveBeenCalledOnce();
  });
});
