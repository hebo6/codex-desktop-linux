import {
  act,
  fireEvent,
  render as testingLibraryRender,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import type { ReactElement, ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { RestoredThread, ThreadTurn } from "../app/useServerThreads";
import type { TurnItemPageState } from "../app/useThreadSession";
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
      composer={<div data-conversation-composer />}
    >
      {children}
    </ConversationWorkspace>
  );
}

function render(ui: ReactElement) {
  return testingLibraryRender(ui, { wrapper: TestConversationWorkspace });
}

function userScroll(scroller: HTMLElement, scrollTop: number) {
  fireEvent.wheel(scroller, {
    deltaY: scrollTop < scroller.scrollTop ? -1 : 1,
  });
  scroller.scrollTop = scrollTop;
  fireEvent.scroll(scroller);
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
  turns: [TURN],
} satisfies RestoredThread;

describe("ConversationView", () => {
  it("通过活动组逐页加载摘要回合并在完成后移除加载入口", async () => {
    const user = TURN.items[0]!;
    const command = TURN.items.find(({ id }) => id === "command")!;
    const answer = TURN.items.at(-1)!;
    const summaryTurn = {
      ...TURN,
      items: [user, answer],
      itemsView: "summary" as const,
    } satisfies ThreadTurn;
    const onLoadTurnItemPage = vi.fn(async () => true);
    const { rerender } = render(
      <ConversationView
        onLoadTurnItemPage={onLoadTurnItemPage}
        restoredThread={{ ...RESTORED, turns: [summaryTurn] }}
      />,
    );

    expect(screen.getByText("请检查项目")).toBeVisible();
    expect(screen.getByText("已经完成检查")).toBeVisible();
    expect(screen.queryByText("pnpm test")).not.toBeInTheDocument();
    expect(screen.queryByText(/展开.*详细过程/u)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /已运行/u }));
    expect(onLoadTurnItemPage).toHaveBeenCalledWith("turn-1");

    const partialTurn = {
      ...summaryTurn,
      clientItemsView: "partial" as const,
      items: [user, command, answer],
    } satisfies ThreadTurn;
    const partialPage = {
      items: [user, command],
      nextCursor: "next-items",
      complete: false,
      loading: false,
      error: false,
    } satisfies TurnItemPageState;
    rerender(
      <ConversationView
        onLoadTurnItemPage={onLoadTurnItemPage}
        restoredThread={{ ...RESTORED, turns: [partialTurn] }}
        turnItemPages={new Map([["turn-1", partialPage]])}
      />,
    );

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /已运行/u }))
        .toHaveAttribute("aria-expanded", "true");
    });
    await waitFor(() => expect(screen.getByText("Ran pnpm test")).toBeVisible());
    fireEvent.click(screen.getByRole("button", { name: "加载更多活动" }));
    expect(onLoadTurnItemPage).toHaveBeenCalledTimes(2);

    const completePage = {
      ...partialPage,
      items: TURN.items,
      nextCursor: null,
      complete: true,
    } satisfies TurnItemPageState;
    rerender(
      <ConversationView
        onLoadTurnItemPage={onLoadTurnItemPage}
        restoredThread={RESTORED}
        turnItemPages={new Map([["turn-1", completePage]])}
      />,
    );

    expect(screen.queryByRole("button", { name: /加载更多活动/u }))
      .not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /已运行/u }))
      .toHaveAttribute("aria-expanded", "true");

    rerender(
      <ConversationView
        onLoadTurnItemPage={onLoadTurnItemPage}
        restoredThread={{
          ...RESTORED,
          turns: [{ ...summaryTurn, itemsView: "full" as const }],
        }}
      />,
    );
    expect(screen.queryByRole("button", { name: /已运行/u }))
      .not.toBeInTheDocument();
  });

  it("在活动组标题反馈首次加载状态并支持失败重试", () => {
    const user = TURN.items[0]!;
    const answer = TURN.items.at(-1)!;
    const summaryTurn = {
      ...TURN,
      items: [user, answer],
      itemsView: "summary" as const,
    } satisfies ThreadTurn;
    const onLoadTurnItemPage = vi.fn(async () => true);
    const { rerender } = render(
      <ConversationView
        onLoadTurnItemPage={onLoadTurnItemPage}
        restoredThread={{ ...RESTORED, turns: [summaryTurn] }}
        turnItemPages={new Map([["turn-1", {
          items: [],
          nextCursor: null,
          complete: false,
          loading: true,
          error: false,
        }]])}
      />,
    );

    const loadingGroup = screen.getByRole("button", {
      name: /已运行.*正在加载/u,
    });
    expect(loadingGroup).toBeDisabled();
    expect(loadingGroup).toHaveAttribute("aria-busy", "true");

    rerender(
      <ConversationView
        onLoadTurnItemPage={onLoadTurnItemPage}
        restoredThread={{ ...RESTORED, turns: [summaryTurn] }}
        turnItemPages={new Map([["turn-1", {
          items: [],
          nextCursor: null,
          complete: false,
          loading: false,
          error: true,
        }]])}
      />,
    );

    const failedGroup = screen.getByRole("button", {
      name: /已运行.*加载失败，点击重试/u,
    });
    expect(failedGroup).toBeEnabled();
    fireEvent.click(failedGroup);
    expect(onLoadTurnItemPage).toHaveBeenCalledWith("turn-1");
  });

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
            { type: "audio" as const, url: "data:audio/wav;base64,AAAA" },
            { path: "/workspace/recording.ogg", type: "localAudio" as const },
          ],
          id: "user-markdown",
          type: "userMessage" as const,
        },
        { id: "answer-markdown", phase: "final_answer" as const, text: "收到", type: "agentMessage" as const },
      ],
    } satisfies ThreadTurn;

    render(
      <ConversationView
        onOpenLink={onOpenLink}
        restoredThread={{ ...RESTORED, turns: [markdownTurn] }}
      />,
    );

    expect(screen.getByRole("heading", { name: "检查范围" })).toBeVisible();
    expect(screen.getByText("重点")).toBeVisible();
    expect(screen.getByText("危险")).toBeVisible();
    expect(document.querySelector("script")).toBeNull();
    expect(screen.getByText("@README")).toBeVisible();
    expect(screen.getByText("音频附件")).toBeVisible();
    expect(screen.getByText("recording.ogg")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "源码" }));
    expect(onOpenLink).toHaveBeenCalledWith("src/App.tsx");
  });

  it("仅允许从已完成的最终回答执行 Shell 代码块", async () => {
    const onRunShellCommand = vi.fn(async () => true);
    const shellTurn = {
      ...TURN,
      items: [
        {
          id: "commentary-shell",
          phase: "commentary" as const,
          text: "```bash\necho commentary\n```",
          type: "agentMessage" as const,
        },
        {
          id: "answer-shell",
          phase: "final_answer" as const,
          text: [
            "```bash",
            "echo answer",
            "```",
            "",
            "```ts",
            "console.log('not shell')",
            "```",
          ].join("\n"),
          type: "agentMessage" as const,
        },
      ],
      status: "completed" as const,
    } satisfies ThreadTurn;
    const { rerender } = render(
      <ConversationView
        onRunShellCommand={onRunShellCommand}
        restoredThread={{ ...RESTORED, turns: [shellTurn] }}
      />,
    );

    const trigger = screen.getByRole("button", { name: "执行 Shell 命令" });
    expect(screen.getAllByRole("button", { name: "执行 Shell 命令" }))
      .toHaveLength(1);
    fireEvent.click(trigger);
    fireEvent.click(
      within(screen.getByRole("alertdialog"))
        .getByRole("button", { name: "执行" }),
    );
    await waitFor(() =>
      expect(onRunShellCommand).toHaveBeenCalledWith("echo answer")
    );

    rerender(
      <ConversationView
        onRunShellCommand={onRunShellCommand}
        restoredThread={{
          ...RESTORED,
          turns: [{ ...shellTurn, status: "inProgress" }],
        }}
      />,
    );
    expect(screen.queryByRole("button", { name: "执行 Shell 命令" }))
      .not.toBeInTheDocument();
  });

  it("存在活动回合或 Shell 命令时禁用回答中的执行入口", () => {
    const shellTurn = {
      ...TURN,
      items: [{
        id: "answer-disabled-shell",
        phase: "final_answer" as const,
        text: "```zsh\npwd\n```",
        type: "agentMessage" as const,
      }],
      status: "completed" as const,
    } satisfies ThreadTurn;
    render(
      <ConversationView
        onRunShellCommand={vi.fn(async () => true)}
        restoredThread={{ ...RESTORED, turns: [shellTurn] }}
        shellCommandDisabled
      />,
    );

    expect(screen.getByRole("button", { name: "执行 Shell 命令" }))
      .toBeDisabled();
  });

  it("用户消息图片通过 Blob URL 显示缩略图并打开统一预览", async () => {
    const create = vi.fn(() => "blob:user-message-image");
    const revoke = vi.fn();
    const onOpenImage = vi.fn();
    const imageUrl = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==";
    const imageTurn = {
      ...TURN,
      items: [
        {
          content: [
            { type: "text" as const, text: "检查截图" },
            { type: "image" as const, url: imageUrl },
            {
              type: "image" as const,
              url: "data:image/svg+xml;base64,PHN2Zy8+",
            },
          ],
          id: "user-image",
          type: "userMessage" as const,
        },
      ],
    } satisfies ThreadTurn;

    const { unmount } = render(
      <ConversationView
        blobUrlFactory={{ create, revoke }}
        onOpenImage={onOpenImage}
        restoredThread={{ ...RESTORED, turns: [imageTurn] }}
      />,
    );

    const image = await screen.findByRole("img", { name: "粘贴图片.png" });
    expect(image).toHaveAttribute("src", "blob:user-message-image");
    expect(create).toHaveBeenCalledWith(expect.any(Blob));
    fireEvent.click(screen.getByRole("button", { name: "预览粘贴图片.png" }));
    expect(onOpenImage).toHaveBeenCalledWith(imageUrl, "粘贴图片.png");
    expect(screen.getByText("图片附件不可预览")).toBeVisible();

    fireEvent.error(image);
    expect(screen.getByText("粘贴图片.png加载失败")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    await waitFor(() => expect(create).toHaveBeenCalledTimes(2));
    expect(screen.getByRole("img", { name: "粘贴图片.png" })).toHaveAttribute(
      "src",
      "blob:user-message-image",
    );
    expect(revoke).toHaveBeenCalledWith("blob:user-message-image");

    unmount();
    expect(revoke).toHaveBeenCalledTimes(2);
  });

  it("覆盖全部持久化 ThreadItem 的稳定展示", async () => {
    render(
      <ConversationView
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
        expect(getComputedStyle(activityGroup).position).toBe("static");
      }
    });
    await waitFor(() => expect(screen.getByText("Hook 提示")).toBeVisible());
    fireEvent.click(screen.getByRole("button", { name: "Ran pnpm test" }));
    const commandHeading = screen.getByRole("button", { name: "Ran pnpm test" });
    await waitFor(() => {
      expect(getComputedStyle(commandHeading).position).toBe("static");
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
        restoredThread={{ ...RESTORED, turns: [commandTurn] }}
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

  it("将用户 Shell 从 AI 活动组拆出并显示原始命令", async () => {
    const shellTurn = {
      durationMs: 3_000,
      id: "turn-user-shell",
      items: [
        {
          content: [{ text: "检查后运行测试", type: "text" as const }],
          id: "user-before-shell",
          type: "userMessage" as const,
        },
        {
          id: "reasoning-before-shell",
          summary: ["先检查测试配置"],
          type: "reasoning" as const,
        },
        {
          aggregatedOutput: "Test Files  73 passed",
          command: "/usr/bin/zsh -lc 'pnpm test -- --runInBand'",
          commandActions: [
            {
              command: "pnpm test -- --runInBand",
              name: "package.json",
              path: "/workspace/project/package.json",
              type: "read" as const,
            },
          ],
          cwd: "/workspace/project",
          durationMs: 1_500,
          exitCode: 0,
          id: "command-user-shell",
          source: "userShell" as const,
          status: "completed" as const,
          type: "commandExecution" as const,
        },
        {
          command: "git status --short",
          commandActions: [],
          cwd: "/workspace/project",
          id: "command-agent-after-shell",
          status: "completed" as const,
          type: "commandExecution" as const,
        },
        {
          id: "answer-after-shell",
          phase: "final_answer" as const,
          text: "测试已通过",
          type: "agentMessage" as const,
        },
      ],
      itemsView: "full" as const,
      status: "completed" as const,
    } satisfies ThreadTurn;
    render(
      <ConversationView
        restoredThread={{ ...RESTORED, turns: [shellTurn] }}
      />,
    );

    expect(screen.getAllByRole("button", { name: /已运行/u })).toHaveLength(2);
    const shellHeader = screen.getByRole("button", {
      name: "pnpm test -- --runInBand，已完成 · 1.5 秒",
    });
    const shellRecord = shellHeader.closest("section");
    expect(shellRecord).not.toBeNull();
    expect(shellRecord).not.toHaveAttribute("data-activity-group");
    expect(within(shellRecord!).getByText("pnpm test -- --runInBand")).toBeVisible();
    expect(within(shellRecord!).queryByText(/你执行的 Shell/u)).not.toBeInTheDocument();
    expect(within(shellRecord!).queryByText(/\/usr\/bin\/zsh/u)).not.toBeInTheDocument();
    expect(screen.queryByText("Read package.json")).not.toBeInTheDocument();
    expect(shellHeader).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText(/Test Files\s+73 passed/u)).toBeVisible();

    fireEvent.click(shellHeader);
    expect(shellHeader).toHaveAttribute("aria-expanded", "false");
    await waitFor(() => {
      expect(screen.queryByText(/Test Files\s+73 passed/u)).not.toBeInTheDocument();
    });
  });

  it("已完成的独立用户 Shell 不显示空活动组并默认展开", () => {
    const shellTurn = {
      durationMs: 480,
      id: "turn-completed-user-shell",
      items: [
        {
          aggregatedOutput: "/workspace/project",
          command: "pwd",
          commandActions: [],
          cwd: "/workspace/project",
          durationMs: 480,
          exitCode: 0,
          id: "command-completed-user-shell",
          source: "userShell" as const,
          status: "completed" as const,
          type: "commandExecution" as const,
        },
      ],
      itemsView: "notLoaded" as const,
      status: "completed" as const,
    } satisfies ThreadTurn;
    render(
      <ConversationView
        restoredThread={{ ...RESTORED, turns: [shellTurn] }}
      />,
    );

    expect(document.querySelector("[data-activity-group]")).toBeNull();
    const shellHeader = screen.getByRole("button", {
      name: "pwd，已完成 · 480 毫秒",
    });
    expect(shellHeader).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("/workspace/project")).toBeVisible();
  });

  it("运行中的用户 Shell 默认展开并显示运行状态", () => {
    const shellTurn = {
      id: "turn-running-user-shell",
      items: [
        {
          aggregatedOutput: "正在编译",
          command: "pnpm build",
          commandActions: [],
          cwd: "/workspace/project",
          durationMs: 12_000,
          id: "command-running-user-shell",
          source: "userShell" as const,
          status: "inProgress" as const,
          type: "commandExecution" as const,
        },
      ],
      itemsView: "full" as const,
      status: "inProgress" as const,
    } satisfies ThreadTurn;
    render(
      <ConversationView
        restoredThread={{ ...RESTORED, turns: [shellTurn] }}
      />,
    );

    expect(document.querySelector("[data-activity-group]")).toBeNull();
    const shellHeader = screen.getByRole("button", {
      name: "pnpm build，正在运行 · 12 秒",
    });
    expect(shellHeader).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("正在编译")).toBeVisible();
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
        onOpenLink={onOpenLink}
        restoredThread={{ ...RESTORED, turns: [reasoningTurn] }}
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
        onOpenDiff={onOpenDiff}
        restoredThread={{ ...RESTORED, turns: [fileTurn] }}
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
        restoredThread={{ ...RESTORED, turns: [finalAnswerTurn] }}
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

  it("最终回答开始时自动折叠仍有运行中命令的活动组", async () => {
    const runningTurn = {
      id: "turn-running-command-collapse",
      items: [
        {
          content: [{ text: "运行命令", type: "text" as const }],
          id: "user-running-command-collapse",
          type: "userMessage" as const,
        },
        {
          id: "reasoning-running-command-collapse",
          summary: ["等待命令完成"],
          type: "reasoning" as const,
        },
        {
          aggregatedOutput: "仍在运行",
          command: "pnpm test",
          commandActions: [],
          cwd: "/workspace/project",
          id: "command-running-command-collapse",
          status: "inProgress" as const,
          type: "commandExecution" as const,
        },
      ],
      itemsView: "full" as const,
      status: "inProgress" as const,
    } satisfies ThreadTurn;
    const { rerender } = render(
      <ConversationView
        restoredThread={{ ...RESTORED, turns: [runningTurn] }}
      />,
    );
    const activityGroup = screen.getByRole("button", {
      name: "1 个命令正在运行",
    });
    expect(activityGroup).toHaveAttribute("aria-expanded", "true");

    const answeringTurn = {
      ...runningTurn,
      items: [
        ...runningTurn.items,
        {
          id: "answer-running-command-collapse",
          phase: "final_answer" as const,
          text: "命令仍在后台运行",
          type: "agentMessage" as const,
        },
      ],
    } satisfies ThreadTurn;
    rerender(
      <ConversationView
        restoredThread={{ ...RESTORED, turns: [answeringTurn] }}
      />,
    );

    await waitFor(() =>
      expect(screen.getByRole("button", {
        name: "1 个命令正在运行",
      })).toHaveAttribute("aria-expanded", "false")
    );
    expect(screen.getByText("命令仍在后台运行")).toBeVisible();
    await waitFor(() =>
      expect(screen.queryByText("等待命令完成")).not.toBeInTheDocument()
    );
  });

  it("最终回答开始时恢复问题位置并停止自动跟随", async () => {
    const viewportHeight = 600;
    let contentHeight = 1_800;
    let finalAnswerDocumentTop = 1_700;
    let contentResize: (() => void) | null = null;
    const originalBoundingRect = HTMLElement.prototype.getBoundingClientRect;
    const originalClientHeight = Object.getOwnPropertyDescriptor(
      HTMLElement.prototype,
      "clientHeight",
    )?.get;
    const originalScrollHeight = Object.getOwnPropertyDescriptor(
      HTMLElement.prototype,
      "scrollHeight",
    )?.get;

    class FakeResizeObserver {
      readonly callback: ResizeObserverCallback;

      constructor(callback: ResizeObserverCallback) {
        this.callback = callback;
      }

      disconnect() {}

      observe(target: Element) {
        if (target.matches("[data-conversation-list]")) {
          contentResize = () =>
            this.callback([], this as unknown as ResizeObserver);
        }
      }

      unobserve() {}
    }

    Object.defineProperty(globalThis, "ResizeObserver", {
      configurable: true,
      value: FakeResizeObserver,
    });
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get")
      .mockImplementation(function (this: HTMLElement) {
        return this.getAttribute("aria-label") === "会话消息"
          ? viewportHeight
          : originalClientHeight?.call(this) ?? 0;
      });
    vi.spyOn(HTMLElement.prototype, "scrollHeight", "get")
      .mockImplementation(function (this: HTMLElement) {
        if (this.getAttribute("aria-label") !== "会话消息") {
          return originalScrollHeight?.call(this) ?? 0;
        }
        const floor = this.querySelector<HTMLElement>(
          '[data-running-turn-floor="true"]',
        );
        const naturalHeight = 28 + contentHeight;
        return floor === null
          ? naturalHeight + 120
          : Math.max(naturalHeight, Number.parseFloat(floor.style.minHeight));
      });
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect")
      .mockImplementation(function (this: HTMLElement) {
        const scroller = this.closest<HTMLElement>('[aria-label="会话消息"]');
        const scrollTop = scroller?.scrollTop ?? 0;
        if (this.getAttribute("aria-label") === "会话消息") {
          return {
            bottom: viewportHeight,
            height: viewportHeight,
            left: 0,
            right: 880,
            top: 0,
            width: 880,
            x: 0,
            y: 0,
            toJSON: () => ({}),
          };
        }
        if (this.matches("[data-conversation-list]")) {
          return {
            bottom: 28 + contentHeight - scrollTop,
            height: contentHeight,
            left: 0,
            right: 880,
            top: 28 - scrollTop,
            width: 880,
            x: 0,
            y: 28 - scrollTop,
            toJSON: () => ({}),
          };
        }
        if (this.matches("[data-activity-group-header]")) {
          return {
            bottom: 136 - scrollTop,
            height: 36,
            left: 0,
            right: 880,
            top: 100 - scrollTop,
            width: 880,
            x: 0,
            y: 100 - scrollTop,
            toJSON: () => ({}),
          };
        }
        if (this.matches("[data-user-message]")) {
          return {
            bottom: 102 - scrollTop,
            height: 50,
            left: 0,
            right: 680,
            top: 52 - scrollTop,
            width: 680,
            x: 0,
            y: 52 - scrollTop,
            toJSON: () => ({}),
          };
        }
        if (
          this.matches(
            '[data-item-id="answer-final-position"][data-final-answer="true"]',
          )
        ) {
          return {
            bottom: finalAnswerDocumentTop + 50 - scrollTop,
            height: 50,
            left: 0,
            right: 880,
            top: finalAnswerDocumentTop - scrollTop,
            width: 880,
            x: 0,
            y: finalAnswerDocumentTop - scrollTop,
            toJSON: () => ({}),
          };
        }
        return originalBoundingRect.call(this);
      });

    const runningTurn = {
      id: "turn-final-position",
      items: [
        {
          content: [{ text: "检查最终回答定位", type: "text" as const }],
          id: "user-final-position",
          type: "userMessage" as const,
        },
        {
          id: "reasoning-final-position",
          summary: ["很长的运行中活动"],
          type: "reasoning" as const,
        },
      ],
      itemsView: "full" as const,
      status: "inProgress" as const,
    } satisfies ThreadTurn;
    const { rerender } = render(
      <ConversationView
        restoredThread={{ ...RESTORED, turns: [runningTurn] }}
      />,
    );
    const scroller = screen.getByLabelText("会话消息");
    let scrollTop = 0;
    Object.defineProperty(scroller, "scrollTop", {
      configurable: true,
      get: () => scrollTop,
      set: (value: number) => {
        scrollTop = Math.min(
          value,
          Math.max(0, scroller.scrollHeight - scroller.clientHeight),
        );
      },
    });
    await act(async () => {
      await new Promise<void>((resolve) => {
        window.requestAnimationFrame(() => resolve());
      });
    });
    userScroll(scroller, 800);
    expect(screen.getByRole("button", { name: "回到底部" })).toBeVisible();

    const answeringTurn = {
      ...runningTurn,
      items: [
        ...runningTurn.items,
        {
          id: "answer-final-position",
          phase: "final_answer" as const,
          text: "最终回答开始",
          type: "agentMessage" as const,
        },
      ],
    } satisfies ThreadTurn;
    rerender(
      <ConversationView
        restoredThread={{ ...RESTORED, turns: [answeringTurn] }}
      />,
    );

    const question = screen.getByText("检查最终回答定位").closest<HTMLElement>(
      "[data-user-message]",
    );
    await waitFor(() => expect(question?.getBoundingClientRect().top).toBe(52));
    expect(scroller.scrollTop).toBe(0);
    expect(screen.queryByRole("button", { name: "回到底部" }))
      .not.toBeInTheDocument();

    contentHeight = 500;
    finalAnswerDocumentTop = 400;
    act(() => contentResize?.());

    await waitFor(() => expect(question?.getBoundingClientRect().top).toBe(52));
    expect(scroller.scrollTop).toBe(0);
    expect(scroller.scrollTop).toBe(
      scroller.scrollHeight - scroller.clientHeight,
    );
    await waitFor(() =>
      expect(scroller.querySelector("[data-activity-group]"))
        .toHaveAttribute("data-content-mounted", "false")
    );
    act(() => contentResize?.());

    contentHeight = 1_000;
    finalAnswerDocumentTop = 900;
    act(() => contentResize?.());

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "回到底部" })).toBeVisible()
    );
    expect(scroller.scrollTop).toBe(0);

    fireEvent.click(screen.getByRole("button", { name: "回到底部" }));
    expect(scroller.scrollTop).toBe(428);

    contentHeight = 1_200;
    finalAnswerDocumentTop = 1_100;
    act(() => contentResize?.());

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "回到底部" })).toBeVisible()
    );
    expect(scroller.scrollTop).toBe(428);
  });

  it("位于底部时内容增长后继续跟随底部", () => {
    const { rerender } = render(
      <ConversationView
        restoredThread={RESTORED}
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
        restoredThread={{ ...RESTORED, turns: [expandedTurn] }}
      />,
    );

    expect(scroller.scrollTop).toBe(1_200);
    expect(screen.queryByRole("button", { name: "回到底部" }))
      .not.toBeInTheDocument();
  });

  it("按原生滚动范围判断是否位于底部", () => {
    render(
      <ConversationView
        restoredThread={RESTORED}
      />,
    );
    const scroller = screen.getByLabelText("会话消息");
    Object.defineProperties(scroller, {
      clientHeight: { configurable: true, value: 500 },
      scrollHeight: { configurable: true, value: 1_500 },
    });

    userScroll(scroller, 1_000);
    expect(screen.queryByRole("button", { name: "回到底部" }))
      .not.toBeInTheDocument();

    userScroll(scroller, 900);
    expect(screen.getByRole("button", { name: "回到底部" })).toBeVisible();
  });

  it("布局变化产生的滚动事件不关闭自动跟随", () => {
    const { rerender } = render(
      <ConversationView
        restoredThread={RESTORED}
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

    scrollHeight = 1_200;
    scroller.scrollTop = 790;
    fireEvent.scroll(scroller);
    expect(screen.queryByRole("button", { name: "回到底部" }))
      .not.toBeInTheDocument();

    const expandedTurn = {
      ...TURN,
      items: TURN.items.flatMap((item) => item.id === "hook"
        ? [
            item,
            {
              id: "commentary-after-layout",
              phase: "commentary" as const,
              text: "布局变化后继续检查",
              type: "agentMessage" as const,
            },
          ]
        : [item]),
    } satisfies ThreadTurn;
    scrollHeight = 1_400;
    rerender(
      <ConversationView
        restoredThread={{ ...RESTORED, turns: [expandedTurn] }}
      />,
    );

    expect(scroller.scrollTop).toBe(1_200);
    expect(screen.queryByRole("button", { name: "回到底部" }))
      .not.toBeInTheDocument();
  });

  it("离开底部后内容增长保持当前滚动位置", () => {
    const activeTurn = {
      id: "turn-standard-scroll",
      items: [
        {
          content: [{ text: "标准滚动问题", type: "text" as const }],
          id: "user-standard-scroll",
          type: "userMessage" as const,
        },
        {
          id: "answer-standard-scroll",
          text: "正在回答",
          type: "agentMessage" as const,
        },
      ],
      itemsView: "full" as const,
      status: "inProgress" as const,
    } satisfies ThreadTurn;
    const activeThread = {
      ...RESTORED,
      turns: [activeTurn],
    } satisfies RestoredThread;
    const { rerender } = render(
      <ConversationView
        restoredThread={activeThread}
      />,
    );
    const scroller = screen.getByLabelText("会话消息");
    let scrollHeight = 1_500;
    Object.defineProperties(scroller, {
      clientHeight: { configurable: true, value: 500 },
      scrollHeight: { configurable: true, get: () => scrollHeight },
    });

    userScroll(scroller, 400);
    scrollHeight = 1_900;
    rerender(
      <ConversationView
        restoredThread={{
          ...activeThread,
          turns: [{
            ...activeTurn,
            items: activeTurn.items.map((item) =>
              item.id === "answer-standard-scroll"
                ? { ...item, text: "正在回答，内容继续增长" }
                : item
            ),
          }],
        }}
      />,
    );

    expect(scroller.scrollTop).toBe(400);
    expect(screen.getByRole("button", { name: "回到底部" })).toBeVisible();
  });

  it("新问题对齐首问位置并由流式内容消耗尾部留白", () => {
    const viewportHeight = 600;
    let contentHeight = 850;
    let latestQuestionDocumentTop = 52;
    const originalBoundingRect = HTMLElement.prototype.getBoundingClientRect;
    const originalClientHeight = Object.getOwnPropertyDescriptor(
      HTMLElement.prototype,
      "clientHeight",
    )?.get;
    const originalScrollHeight = Object.getOwnPropertyDescriptor(
      HTMLElement.prototype,
      "scrollHeight",
    )?.get;
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get")
      .mockImplementation(function (this: HTMLElement) {
        return this.getAttribute("aria-label") === "会话消息"
          ? viewportHeight
          : originalClientHeight?.call(this) ?? 0;
      });
    vi.spyOn(HTMLElement.prototype, "scrollHeight", "get")
      .mockImplementation(function (this: HTMLElement) {
        if (this.getAttribute("aria-label") !== "会话消息") {
          return originalScrollHeight?.call(this) ?? 0;
        }
        const floor = this.querySelector<HTMLElement>(
          '[data-running-turn-floor="true"]',
        );
        const naturalHeight = 28 + contentHeight;
        return floor === null
          ? naturalHeight + 120
          : Math.max(naturalHeight, Number.parseFloat(floor.style.minHeight));
      });
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect")
      .mockImplementation(function (this: HTMLElement) {
        const scroller = this.closest<HTMLElement>('[aria-label="会话消息"]');
        const scrollTop = scroller?.scrollTop ?? 0;
        if (this.getAttribute("aria-label") === "会话消息") {
          return {
            bottom: viewportHeight,
            height: viewportHeight,
            left: 0,
            right: 880,
            top: 0,
            width: 880,
            x: 0,
            y: 0,
            toJSON: () => ({}),
          };
        }
        if (this.matches("[data-conversation-list]")) {
          return {
            bottom: 28 + contentHeight - scrollTop,
            height: contentHeight,
            left: 0,
            right: 880,
            top: 28 - scrollTop,
            width: 880,
            x: 0,
            y: 28 - scrollTop,
            toJSON: () => ({}),
          };
        }
        if (this.matches("[data-user-message]")) {
          const questionIndex = this.closest<HTMLElement>(
            "[data-question-index]",
          )?.dataset.questionIndex;
          const documentTop = questionIndex === "1"
            ? latestQuestionDocumentTop
            : 52;
          return {
            bottom: documentTop + 50 - scrollTop,
            height: 50,
            left: 0,
            right: 680,
            top: documentTop - scrollTop,
            width: 680,
            x: 0,
            y: documentTop - scrollTop,
            toJSON: () => ({}),
          };
        }
        return originalBoundingRect.call(this);
      });

    const firstTurn = {
      id: "turn-question-position-first",
      items: [
        {
          content: [{ text: "首次问题", type: "text" as const }],
          id: "user-question-position-first",
          type: "userMessage" as const,
        },
        {
          id: "answer-question-position-first",
          phase: "final_answer" as const,
          text: "首次回答",
          type: "agentMessage" as const,
        },
      ],
      itemsView: "full" as const,
      status: "completed" as const,
    } satisfies ThreadTurn;
    const { rerender } = render(
      <ConversationView
        restoredThread={{ ...RESTORED, turns: [firstTurn] }}
      />,
    );
    const scroller = screen.getByLabelText("会话消息");
    let scrollTop = 100;
    Object.defineProperty(scroller, "scrollTop", {
      configurable: true,
      get: () => scrollTop,
      set: (value: number) => {
        scrollTop = Math.min(
          value,
          Math.max(0, scroller.scrollHeight - scroller.clientHeight),
        );
      },
    });

    const activeTurn = {
      id: "turn-question-position-active",
      items: [
        {
          content: [{ text: "后续问题", type: "text" as const }],
          id: "user-question-position-active",
          type: "userMessage" as const,
        },
      ],
      itemsView: "full" as const,
      status: "inProgress" as const,
    } satisfies ThreadTurn;
    contentHeight = 1_050;
    latestQuestionDocumentTop = 1_000;
    rerender(
      <ConversationView
        restoredThread={{ ...RESTORED, turns: [firstTurn, activeTurn] }}
      />,
    );

    const floor = scroller.querySelector<HTMLElement>(
      '[data-running-turn-floor="true"]',
    );
    const latestQuestion = screen.getByText("后续问题")
      .closest<HTMLElement>("[data-user-message]");
    expect(floor).toHaveStyle({ minHeight: "1548px" });
    expect(scroller.scrollTop).toBe(948);
    expect(latestQuestion?.getBoundingClientRect().top).toBe(52);
    expect(scroller.scrollTop).toBe(
      scroller.scrollHeight - scroller.clientHeight,
    );

    contentHeight = 1_250;
    rerender(
      <ConversationView
        restoredThread={{
          ...RESTORED,
          turns: [
            firstTurn,
            {
              ...activeTurn,
              items: [
                ...activeTurn.items,
                {
                  id: "answer-question-position-active",
                  text: "开始流式回答",
                  type: "agentMessage" as const,
                },
              ],
            },
          ],
        }}
      />,
    );

    expect(floor).toHaveStyle({ minHeight: "1548px" });
    expect(scroller.scrollTop).toBe(948);
    expect(latestQuestion?.getBoundingClientRect().top).toBe(52);
    expect(scroller.scrollTop).toBe(
      scroller.scrollHeight - scroller.clientHeight,
    );
  });

  it("运行中活动和回答填满留白后分段跟随，手动离底后暂停", () => {
    let contentDocumentBottom = 880;
    const viewportHeight = 600;
    const originalBoundingRect = HTMLElement.prototype.getBoundingClientRect;
    const originalClientHeight = Object.getOwnPropertyDescriptor(
      HTMLElement.prototype,
      "clientHeight",
    )?.get;
    const originalScrollHeight = Object.getOwnPropertyDescriptor(
      HTMLElement.prototype,
      "scrollHeight",
    )?.get;
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get")
      .mockImplementation(function (this: HTMLElement) {
        return this.getAttribute("aria-label") === "会话消息"
          ? viewportHeight
          : originalClientHeight?.call(this) ?? 0;
      });
    vi.spyOn(HTMLElement.prototype, "scrollHeight", "get")
      .mockImplementation(function (this: HTMLElement) {
        if (this.getAttribute("aria-label") !== "会话消息") {
          return originalScrollHeight?.call(this) ?? 0;
        }
        const floor = this.querySelector<HTMLElement>(
          '[data-running-turn-floor="true"]',
        );
        return floor === null
          ? contentDocumentBottom + 120
          : Math.max(
            contentDocumentBottom,
            Number.parseFloat(floor.style.minHeight),
          );
      });
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect")
      .mockImplementation(function (this: HTMLElement) {
        if (this.getAttribute("aria-label") === "会话消息") {
          return {
            bottom: viewportHeight,
            height: viewportHeight,
            left: 0,
            right: 880,
            top: 0,
            width: 880,
            x: 0,
            y: 0,
            toJSON: () => ({}),
          };
        }
        if (this.matches("[data-conversation-list]")) {
          const scroller = this.closest<HTMLElement>('[aria-label="会话消息"]');
          const bottom = contentDocumentBottom - (scroller?.scrollTop ?? 0);
          return {
            bottom,
            height: contentDocumentBottom,
            left: 0,
            right: 880,
            top: bottom - contentDocumentBottom,
            width: 880,
            x: 0,
            y: bottom - contentDocumentBottom,
            toJSON: () => ({}),
          };
        }
        return originalBoundingRect.call(this);
      });

    const completedTurn = {
      id: "turn-paged-follow-completed",
      items: [
        {
          content: [{ text: "历史问题", type: "text" as const }],
          id: "user-paged-follow-completed",
          type: "userMessage" as const,
        },
        {
          id: "answer-paged-follow-completed",
          phase: "final_answer" as const,
          text: "历史回答",
          type: "agentMessage" as const,
        },
      ],
      itemsView: "full" as const,
      status: "completed" as const,
    } satisfies ThreadTurn;
    const { rerender } = render(
      <ConversationView
        restoredThread={{ ...RESTORED, turns: [completedTurn] }}
      />,
    );
    const scroller = screen.getByLabelText("会话消息");
    expect(scroller.scrollTop).toBe(400);

    const runningTurn = {
      id: "turn-paged-follow-running",
      items: [
        {
          content: [{ text: "检查分页跟随", type: "text" as const }],
          id: "user-paged-follow-running",
          type: "userMessage" as const,
        },
      ],
      itemsView: "full" as const,
      status: "inProgress" as const,
    } satisfies ThreadTurn;
    contentDocumentBottom = 1_000;
    rerender(
      <ConversationView
        restoredThread={{
          ...RESTORED,
          turns: [completedTurn, { ...runningTurn, status: "completed" }],
        }}
      />,
    );
    rerender(
      <ConversationView
        restoredThread={{ ...RESTORED, turns: [completedTurn, runningTurn] }}
      />,
    );

    expect(scroller.scrollTop).toBe(520);
    expect(scroller.querySelector('[data-running-turn-floor="true"]'))
      .not.toBeInTheDocument();

    const activityTurn = {
      ...runningTurn,
      items: [
        ...runningTurn.items,
        {
          id: "reasoning-paged-follow",
          summary: ["活动到达底边"],
          type: "reasoning" as const,
        },
      ],
    } satisfies ThreadTurn;
    contentDocumentBottom = 1_130;
    rerender(
      <ConversationView
        restoredThread={{ ...RESTORED, turns: [completedTurn, activityTurn] }}
      />,
    );

    const floor = scroller.querySelector<HTMLElement>(
      '[data-running-turn-floor="true"]',
    );
    expect(floor).toHaveStyle({ minHeight: "1530px" });
    expect(scroller.scrollTop).toBe(930);

    const answeringTurn = {
      ...activityTurn,
      items: [
        ...activityTurn.items,
        {
          id: "answer-paged-follow-running",
          text: "回答继续填充留白",
          type: "agentMessage" as const,
        },
      ],
    } satisfies ThreadTurn;
    contentDocumentBottom = 1_400;
    rerender(
      <ConversationView
        restoredThread={{ ...RESTORED, turns: [completedTurn, answeringTurn] }}
      />,
    );
    expect(floor).toHaveStyle({ minHeight: "1530px" });
    expect(scroller.scrollHeight).toBe(1_530);
    expect(scroller.scrollTop).toBe(930);
    expect(scroller.scrollTop).toBe(
      scroller.scrollHeight - scroller.clientHeight,
    );

    contentDocumentBottom = 1_540;
    rerender(
      <ConversationView
        restoredThread={{
          ...RESTORED,
          turns: [
            completedTurn,
            {
              ...answeringTurn,
              items: answeringTurn.items.map((item) =>
                item.id === "answer-paged-follow-running"
                  ? { ...item, text: "回答填满留白并再次到达底边" }
                  : item
              ),
            },
          ],
        }}
      />,
    );
    expect(scroller.scrollTop).toBe(1_340);

    userScroll(scroller, 900);
    contentDocumentBottom = 1_800;
    rerender(
      <ConversationView
        restoredThread={{
          ...RESTORED,
          turns: [
            completedTurn,
            {
              ...answeringTurn,
              items: answeringTurn.items.map((item) =>
                item.id === "answer-paged-follow-running"
                  ? { ...item, text: "手动离底后继续输出" }
                  : item
              ),
            },
          ],
        }}
      />,
    );
    expect(scroller.scrollTop).toBe(900);
    expect(screen.getByRole("button", { name: "回到底部" })).toBeVisible();

    userScroll(scroller, 1_600);
    contentDocumentBottom = 2_210;
    rerender(
      <ConversationView
        restoredThread={{
          ...RESTORED,
          turns: [
            completedTurn,
            {
              ...answeringTurn,
              items: answeringTurn.items.map((item) =>
                item.id === "answer-paged-follow-running"
                  ? { ...item, text: "回到底部后再次填满留白" }
                  : item
              ),
            },
          ],
        }}
      />,
    );
    expect(scroller.scrollTop).toBe(2_010);

    rerender(
      <ConversationView
        restoredThread={{
          ...RESTORED,
          turns: [
            completedTurn,
            { ...answeringTurn, status: "completed" },
          ],
        }}
      />,
    );
    expect(scroller.querySelector('[data-running-turn-floor="true"]'))
      .not.toBeInTheDocument();
    expect(scroller.scrollTop).toBe(1_730);
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
        restoredThread={{ ...RESTORED, turns: [thinkingTurn] }}
      />,
    );

    expect(screen.getByText("Thinking")).toBeVisible();

    const commandTurn = {
      ...thinkingTurn,
      items: [
        ...thinkingTurn.items,
        {
          aggregatedOutput: "\u001b[32m处理中\u001b[0m",
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
        restoredThread={{ ...RESTORED, turns: [commandTurn] }}
      />,
    );

    expect(screen.queryByText("Thinking")).not.toBeInTheDocument();
    expect(screen.getByText("正在运行命令 · 12 秒")).toBeVisible();
    expect(screen.queryByText("处理中")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Running pnpm test" }));
    await waitFor(() => expect(screen.getByText("处理中")).toBeVisible());
    expect(screen.getByText("处理中")).toHaveStyle({
      color: "var(--ansi-color-2)",
    });
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
        restoredThread={{ ...RESTORED, turns: [interruptedTurn] }}
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
        restoredThread={{ ...RESTORED, turns }}
      />,
    );

    const navigation = screen.getByRole("navigation", { name: "历史问题快速导航" });
    const firstMarker = screen.getByRole("button", { name: "跳转到问题 1：问题 1" });
    expect(navigation).toContainElement(firstMarker);
    expect(firstMarker).toHaveTextContent("问题 1");
    expect(firstMarker).toHaveTextContent("回答 1");

    const scroller = screen.getByLabelText("会话消息");
    Object.defineProperties(scroller, {
      clientHeight: { configurable: true, value: 200 },
      scrollHeight: { configurable: true, value: 1_200 },
    });
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
        restoredThread={{ ...RESTORED, turns }}
      />,
    );
    const scroller = screen.getByLabelText("会话消息");
    userScroll(scroller, 100);
    scroller.scrollTop = 320;
    fireEvent.scroll(scroller);
    expect(screen.getAllByText("历史问题 1")).toHaveLength(1);
    expect(screen.getAllByText("历史问题 2")).toHaveLength(1);
    expect(scroller.parentElement?.querySelector("[data-sticky-question]"))
      .not.toBeInTheDocument();
  });

  it("短会话开始流式回答后保持新问题位置", () => {
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
        restoredThread={{ ...RESTORED, turns: [completedTurn] }}
      />,
    );
    const scroller = screen.getByLabelText("会话消息");
    let scrollTop = 0;
    let maximumScrollTop = 0;
    Object.defineProperties(scroller, {
      clientHeight: { configurable: true, value: 800 },
      scrollHeight: {
        configurable: true,
        get: () => maximumScrollTop + 800,
      },
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
        restoredThread={{
          ...RESTORED,
          turns: [completedTurn, activeQuestion],
        }}
      />,
    );

    expect(scroller.scrollTop).toBe(0);
    maximumScrollTop = 1_000;

    rerender(
      <ConversationView
        restoredThread={{
          ...RESTORED,
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

  it("离开底部后活动项更新不改变滚动位置", () => {
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
      turns: [activeTurn],
    } satisfies RestoredThread;
    const { rerender } = render(
      <ConversationView
        restoredThread={activeThread}
      />,
    );
    const scroller = screen.getByLabelText("会话消息");
    Object.defineProperties(scroller, {
      clientHeight: { configurable: true, value: 500 },
      scrollHeight: { configurable: true, value: 1_500 },
    });
    userScroll(scroller, 100);

    rerender(
      <ConversationView
        restoredThread={{
          ...activeThread,
          turns: [{ ...activeTurn, durationMs: 2_000 }],
        }}
      />,
    );

    expect(scroller.scrollTop).toBe(100);
    expect(screen.getByRole("button", { name: "回到底部" })).toBeVisible();

    rerender(
      <ConversationView
        restoredThread={{
          ...activeThread,
          turns: [{ ...activeTurn, durationMs: 3_000 }],
        }}
      />,
    );

    expect(scroller.scrollTop).toBe(100);
    expect(screen.getByRole("button", { name: "回到底部" })).toBeVisible();
  });

  it("回到底部操作使用原生滚动范围并恢复跟随", () => {
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
        restoredThread={{ ...RESTORED, turns: [activeTurn] }}
      />,
    );
    const scroller = screen.getByLabelText("会话消息");
    let scrollHeight = 2_000;
    Object.defineProperties(scroller, {
      clientHeight: { configurable: true, value: 500 },
      scrollHeight: { configurable: true, get: () => scrollHeight },
    });
    userScroll(scroller, 100);

    fireEvent.click(screen.getByRole("button", { name: "回到底部" }));

    expect(scroller.scrollTop).toBe(1_500);
    expect(screen.queryByRole("button", { name: "回到底部" }))
      .not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /正在运行/u })).toBeVisible();

    scrollHeight = 2_200;
    rerender(
      <ConversationView
        restoredThread={{
          ...RESTORED,
          turns: [{ ...activeTurn, durationMs: 1_000 }],
        }}
      />,
    );

    expect(scroller.scrollTop).toBe(1_700);
    expect(screen.queryByRole("button", { name: "回到底部" }))
      .not.toBeInTheDocument();
  });

  it("进行中的回答回到底部后保持可见", () => {
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
        restoredThread={{ ...RESTORED, turns: [activeTurn] }}
      />,
    );
    const scroller = screen.getByLabelText("会话消息");
    Object.defineProperties(scroller, {
      clientHeight: { configurable: true, value: 500 },
      scrollHeight: { configurable: true, value: 2_000 },
    });
    userScroll(scroller, 100);

    fireEvent.click(screen.getByRole("button", { name: "回到底部" }));

    expect(scroller.scrollTop).toBe(1_500);
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
        if (!this.matches("[data-row-key]")) {
          return originalBoundingRect.call(this);
        }
        const height = this.dataset.rowKey?.includes(":segment:user-")
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
        restoredThread={{
          ...RESTORED,
          metadata: { ...RESTORED.metadata, id: "thread-ai-scrolling" },
          turns: [...historyTurns, activeTurn],
        }}
      />,
    );
    const scroller = screen.getByLabelText("会话消息");
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

    await waitFor(() => expect(scroller.scrollTop).toBe(6_760));
    const visibleHistoryAnswers = new Set<string>();
    historyTurns.forEach((_turn, index) => {
      userScroll(scroller, index * 276);
      const answer = `历史 AI 回答 ${index}`;
      const answerRow = scroller.querySelector<HTMLElement>(
        `[data-row-key="turn-ai-history-${index}:segment:answer-ai-history-${index}"]`,
      );
      expect(answerRow).not.toBeNull();
      expect(within(answerRow!).getByText(answer)).toBeVisible();
      visibleHistoryAnswers.add(answer);
    });
    expect(visibleHistoryAnswers.size).toBe(20);

    userScroll(scroller, 0);
    fireEvent.click(screen.getByRole("button", { name: "回到底部" }));
    expect(scroller.scrollTop).toBe(6_760);
    fireEvent.scroll(scroller);

    expect(screen.getByText("当前 AI 进度")).toBeVisible();
    expect(screen.getByText("当前最新 AI 回答")).toBeVisible();
    expect(screen.queryByRole("button", { name: "回到底部" }))
      .not.toBeInTheDocument();
  });

  it("新问题恢复自动跟随，手动离底后运行中内容保持位置", () => {
    const firstTurn = {
      id: "turn-follow-1",
      items: [
        {
          content: [{ text: "历史问题", type: "text" as const }],
          id: "user-follow-1",
          type: "userMessage" as const,
        },
        {
          id: "answer-follow-1",
          phase: "final_answer" as const,
          text: "历史回答",
          type: "agentMessage" as const,
        },
      ],
      itemsView: "full" as const,
      status: "completed" as const,
    } satisfies ThreadTurn;
    const { rerender } = render(
      <ConversationView
        restoredThread={{ ...RESTORED, turns: [firstTurn] }}
      />,
    );
    const scroller = screen.getByLabelText("会话消息");
    let scrollHeight = 1_720;
    Object.defineProperties(scroller, {
      clientHeight: { configurable: true, value: 500 },
      scrollHeight: { configurable: true, get: () => scrollHeight },
    });
    userScroll(scroller, 600);
    expect(screen.getByRole("button", { name: "回到底部" })).toBeVisible();

    const activeTurn = {
      id: "turn-follow-2",
      items: [
        {
          content: [{ text: "新问题", type: "text" as const }],
          id: "user-follow-2",
          type: "userMessage" as const,
        },
      ],
      itemsView: "full" as const,
      status: "inProgress" as const,
    } satisfies ThreadTurn;
    const activeThread = {
      ...RESTORED,
      turns: [firstTurn, activeTurn],
    } satisfies RestoredThread;
    scrollHeight = 2_000;
    rerender(
      <ConversationView
        restoredThread={activeThread}
      />,
    );

    expect(scroller.scrollTop).toBe(0);
    expect(screen.queryByRole("button", { name: "回到底部" }))
      .not.toBeInTheDocument();

    userScroll(scroller, 600);
    const streamingTurn = {
      ...activeTurn,
      items: [
        ...activeTurn.items,
        {
          id: "answer-follow-2",
          text: "正在流式回答",
          type: "agentMessage" as const,
        },
      ],
    } satisfies ThreadTurn;
    scrollHeight = 2_300;
    rerender(
      <ConversationView
        restoredThread={{ ...activeThread, turns: [firstTurn, streamingTurn] }}
      />,
    );

    expect(scroller.scrollTop).toBe(600);
    expect(screen.getByRole("button", { name: "回到底部" })).toBeVisible();
  });

  it("加载更早回合后保持当前滚动锚点", async () => {
    const currentTurn = {
      ...TURN,
      id: "turn-current",
    } satisfies ThreadTurn;
    const olderTurn = {
      ...TURN,
      id: "turn-older",
      items: TURN.items.map((item) => ({ ...item, id: `older-${item.id}` })),
    } satisfies ThreadTurn;
    const onLoadOlderTurns = vi.fn(async () => true);
    const { rerender } = render(
      <ConversationView
        hasOlderTurns
        onLoadOlderTurns={onLoadOlderTurns}
        restoredThread={{ ...RESTORED, turns: [currentTurn] }}
      />,
    );
    const scroller = screen.getByLabelText("会话消息");
    let scrollHeight = 1_000;
    Object.defineProperties(scroller, {
      clientHeight: { configurable: true, value: 500 },
      scrollHeight: { configurable: true, get: () => scrollHeight },
    });
    userScroll(scroller, 120);

    fireEvent.click(screen.getByRole("button", { name: "加载更早内容" }));
    expect(onLoadOlderTurns).toHaveBeenCalledOnce();

    scrollHeight = 1_360;
    rerender(
      <ConversationView
        hasOlderTurns={false}
        onLoadOlderTurns={onLoadOlderTurns}
        restoredThread={{ ...RESTORED, turns: [olderTurn, currentTurn] }}
      />,
    );

    await waitFor(() => expect(scroller.scrollTop).toBe(480));
  });

  it("从回答所在 turn 发起分叉并标记最新回合", () => {
    const onForkTurn = vi.fn();
    render(
      <ConversationView
        onForkTurn={onForkTurn}
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
        onForkTurn={vi.fn()}
        restoredThread={{ ...RESTORED, turns }}
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

  it("长消息流挂载全部内容", () => {
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
      turns: [longTurn],
    } satisfies RestoredThread;

    render(
      <ConversationView
        restoredThread={longThread}
      />,
    );

    expect(screen.getAllByText(/回答 \d+/u)).toHaveLength(1_000);
  });

  it("从侧边栏加载会话后等待真实行高再定位到底部", async () => {
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
        const rows = list?.querySelectorAll<HTMLElement>("[data-row-key]") ?? [];
        return Array.from(rows).reduce(
          (height, row) => height + row.getBoundingClientRect().height,
          148,
        );
      });
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect")
      .mockImplementation(function (this: HTMLElement) {
        if (!this.matches("[data-row-key]")) {
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
      turns: [turn],
    } satisfies RestoredThread;
    const { rerender } = render(<ConversationPlaceholder kind="loading" />);

    rerender(
      <ConversationView
        restoredThread={loadedThread}
      />,
    );

    const scroller = screen.getByLabelText("会话消息");
    expect(scroller.querySelectorAll("[data-row-key]")).toHaveLength(2);
    await waitFor(() =>
      expect(scroller.scrollTop).toBe(
        scroller.scrollHeight - scroller.clientHeight,
      ),
    );
  });

  it("从侧边栏加载完整长会话后定位到底部", async () => {
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
        const rows = list?.querySelectorAll<HTMLElement>("[data-row-key]") ?? [];
        return Array.from(rows).reduce(
          (height, row) => height + row.getBoundingClientRect().height,
          148,
        );
      });
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect")
      .mockImplementation(function (this: HTMLElement) {
        if (!this.matches("[data-row-key]")) {
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
      turns,
    } satisfies RestoredThread;
    const { rerender } = render(<ConversationPlaceholder kind="loading" />);

    rerender(
      <ConversationView
        restoredThread={loadedThread}
      />,
    );

    const scroller = screen.getByLabelText("会话消息");
    await waitFor(() =>
      expect(scroller.querySelector(
        '[data-row-key="turn-loaded-19:segment:answer-loaded-19"]',
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
    rerender(
      <ConversationPlaceholder
        detail="当前会话使用 legacy 历史格式，无法加载完整历史"
        kind="error"
      />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent(
      "当前会话使用 legacy 历史格式，无法加载完整历史",
    );
    const onNewTask = vi.fn();
    rerender(
      <ConversationPlaceholder kind="deleted" onNewTask={onNewTask} />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent("不能继续提交输入");
    fireEvent.click(screen.getByRole("button", { name: "返回新建页" }));
    expect(onNewTask).toHaveBeenCalledOnce();
  });
});
