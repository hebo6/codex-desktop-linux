import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { CSSProperties } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type {
  HighlightedLines,
  SyntaxHighlighter,
} from "../content/syntaxHighlighting";
import type { ProtocolTraceBatch } from "../transport/protocolTrace";
import { ProtocolDebugWindow } from "./ProtocolDebugWindow";

const traceMocks = vi.hoisted(() => ({
  clear: vi.fn(async () => undefined),
  subscribe: vi.fn(),
}));

vi.mock("../transport/protocolTrace", () => ({
  clearProtocolTrace: traceMocks.clear,
  subscribeProtocolTrace: traceMocks.subscribe,
}));

describe("ProtocolDebugWindow", () => {
  let deliver: (batch: ProtocolTraceBatch) => void;

  beforeEach(() => {
    traceMocks.clear.mockClear();
    traceMocks.subscribe.mockReset();
    traceMocks.subscribe.mockImplementation(async (
      onBatch: (batch: ProtocolTraceBatch) => void,
    ) => {
      deliver = onBatch;
      return vi.fn();
    });
  });

  it("通过弹性拖拽区分隔标题和右侧窗口按钮", () => {
    render(<ProtocolDebugWindow />);

    const titlebar = screen.getByText("协议检查器").closest("header");
    const dragRegion = titlebar?.querySelector(":scope > span");

    expect(titlebar).not.toBeNull();
    expect(dragRegion).not.toBeNull();
    expect(titlebar).toHaveAttribute("data-window-menu-region", "self");
    expect(dragRegion).toHaveAttribute("data-window-menu-region", "self");
    expect(screen.getByText("协议检查器").parentElement).toHaveAttribute(
      "data-window-menu-region",
      "deep",
    );
    expect(getComputedStyle(titlebar!).display).toBe("flex");
    expect(getComputedStyle(dragRegion!).flexGrow).toBe("1");
  });

  it("展示追踪消息、配对方法和脱敏后的 JSON", async () => {
    render(<ProtocolDebugWindow />);
    await waitFor(() => expect(traceMocks.subscribe).toHaveBeenCalledTimes(1));

    act(() => deliver(batch()));

    expect(screen.getAllByText("thread/list")).not.toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: /turn\/start/u }));
    expect(screen.getAllByText("客户端 → 服务端")).not.toHaveLength(0);
    expect(screen.getByText(/\[已脱敏\]/u)).toBeVisible();
    expect(screen.getByText(/2 条 ·/u)).toBeVisible();
  });

  it("使用 Worker 高亮选中的格式化 JSON", async () => {
    const syntaxHighlighter: SyntaxHighlighter = {
      highlight: vi.fn(async (source, language) => {
        expect(language).toBe("json");
        return highlightedLines(source);
      }),
    };
    const { container } = render(
      <ProtocolDebugWindow syntaxHighlighter={syntaxHighlighter} />,
    );
    await waitFor(() => expect(traceMocks.subscribe).toHaveBeenCalledTimes(1));

    act(() => deliver(batch()));
    fireEvent.click(screen.getByRole("button", { name: /turn\/start/u }));

    await waitFor(() => {
      expect(syntaxHighlighter.highlight).toHaveBeenCalledWith(
        [
          "{",
          '  "id": "request-1",',
          '  "method": "turn/start",',
          '  "token": "[已脱敏]"',
          "}",
        ].join("\n"),
        "json",
      );
      expect(container.querySelector("pre code span")).toHaveStyle(
        "--shiki-light: #123456",
      );
    });
  });

  it("切换消息后忽略上一条消息延迟返回的高亮结果", async () => {
    const pending = new Map<string, (lines: HighlightedLines) => void>();
    const syntaxHighlighter: SyntaxHighlighter = {
      highlight: vi.fn((source) =>
        new Promise((resolve) => pending.set(source, resolve))
      ),
    };
    const { container } = render(
      <ProtocolDebugWindow syntaxHighlighter={syntaxHighlighter} />,
    );
    await waitFor(() => expect(traceMocks.subscribe).toHaveBeenCalledTimes(1));

    act(() => deliver(batch()));
    const responseSource = prettyJson(batch().entries[1]!.payload);
    await waitFor(() => expect(pending.has(responseSource)).toBe(true));

    fireEvent.click(screen.getByRole("button", { name: /turn\/start/u }));
    const requestSource = prettyJson(batch().entries[0]!.payload);
    await waitFor(() => expect(pending.has(requestSource)).toBe(true));
    act(() => pending.get(requestSource)!(highlightedLines(requestSource)));
    await waitFor(() => {
      expect(container.querySelector("pre code")?.textContent).toContain(
        "turn/start",
      );
      expect(container.querySelector("pre code span")).not.toBeNull();
    });

    act(() => pending.get(responseSource)!(highlightedLines(responseSource)));
    expect(container.querySelector("pre code")?.textContent).toContain(
      "turn/start",
    );
    expect(container.querySelector("pre code")?.textContent).not.toContain(
      "thread/list",
    );
  });

  it("过滤方向并通过后端清空内存追踪", async () => {
    render(<ProtocolDebugWindow />);
    await waitFor(() => expect(traceMocks.subscribe).toHaveBeenCalledTimes(1));
    act(() => deliver(batch()));

    fireEvent.change(screen.getByRole("combobox", { name: "方向" }), {
      target: { value: "inbound" },
    });
    expect(screen.queryByText("turn/start")).not.toBeInTheDocument();
    expect(screen.getAllByText("thread/list")).not.toHaveLength(0);

    fireEvent.click(screen.getByRole("button", { name: "清空" }));
    await waitFor(() => expect(traceMocks.clear).toHaveBeenCalledTimes(1));
    expect(screen.getByText("等待 app-server 协议消息")).toBeVisible();
  });
});

const TOKEN_STYLE = {
  "--shiki-light": "#123456",
  "--shiki-dark": "#abcdef",
} as CSSProperties;

function highlightedLines(source: string): HighlightedLines {
  return source.split("\n").map((line) => [{
    content: line,
    style: TOKEN_STYLE,
  }]);
}

function prettyJson(source: string): string {
  return JSON.stringify(JSON.parse(source) as unknown, null, 2);
}

function batch(): ProtocolTraceBatch {
  return {
    reset: false,
    entries: [
      {
        sequence: 1,
        timestampMs: 1_700_000_000_000,
        direction: "outbound",
        scope: "configured",
        serverId: "11111111-1111-4111-8111-111111111111",
        connectionId: "pool-11111111-1111-4111-8111-111111111111",
        transport: "localStdio",
        connectionPath: "localStdio",
        windowLabel: "main",
        kind: "request",
        method: "turn/start",
        requestId: "request-1",
        payload: "{\"id\":\"request-1\",\"method\":\"turn/start\",\"token\":\"[已脱敏]\"}",
        originalBytes: 75,
        truncated: false,
      },
      {
        sequence: 2,
        timestampMs: 1_700_000_000_010,
        direction: "inbound",
        scope: "configured",
        serverId: "11111111-1111-4111-8111-111111111111",
        connectionId: "pool-11111111-1111-4111-8111-111111111111",
        transport: "localStdio",
        connectionPath: "localStdio",
        windowLabel: "main",
        kind: "response",
        method: "thread/list",
        requestId: "request-2",
        durationMs: 8.4,
        payload: "{\"id\":\"request-2\",\"result\":{}}",
        originalBytes: 33,
        truncated: false,
      },
    ],
    oldestSequence: 1,
    retainedCount: 2,
    retainedBytes: 108,
    evictedCount: 0,
  };
}
