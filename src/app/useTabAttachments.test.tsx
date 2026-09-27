import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { WindowTab } from "../transport/windowState";
import { useTabAttachments, type DraftAttachment } from "./useTabAttachments";

const attachment: DraftAttachment = {
  id: "image",
  name: "image.png",
  size: 3,
  blob: new Blob(["png"], { type: "image/png" }),
  error: null,
  status: "ready",
};

interface HookProps {
  readonly serverId: string;
  readonly tabs: readonly WindowTab[];
  readonly activeTabId: string;
}

function renderAttachments(initialProps: HookProps) {
  return renderHook(({ serverId, tabs, activeTabId }: HookProps) =>
    useTabAttachments(serverId, tabs, activeTabId).draft,
  { initialProps });
}

describe("useTabAttachments", () => {
  it("首次创建会话保留附件，已有会话被替换时丢弃附件及过期读取结果", () => {
    const initialProps: HookProps = {
      serverId: "server",
      tabs: [{ id: "tab", threadId: null }],
      activeTabId: "tab",
    };
    const { result, rerender } = renderAttachments(initialProps);
    const updateOriginal = result.current[1];
    act(() => updateOriginal([attachment]));

    rerender({ ...initialProps, tabs: [{ id: "tab", threadId: "thread" }] });
    expect(result.current[0]).toEqual([attachment]);
    act(() => updateOriginal((current) => [...current, { ...attachment, id: "second" }]));
    expect(result.current[0]).toHaveLength(2);

    rerender(initialProps);
    expect(result.current[0]).toEqual([]);
    act(() => updateOriginal([attachment]));
    expect(result.current[0]).toEqual([]);
  });

  it.each(["关闭标签", "切换服务器"])("%s 后不恢复附件或接收过期读取结果", (operation) => {
    const initialProps: HookProps = {
      serverId: "server",
      tabs: [{ id: "tab", threadId: "thread" }],
      activeTabId: "tab",
    };
    const { result, rerender } = renderAttachments(initialProps);
    const updateOriginal = result.current[1];
    act(() => updateOriginal([attachment]));

    rerender(operation === "关闭标签"
      ? { ...initialProps, tabs: [] }
      : { ...initialProps, serverId: "other-server" });
    expect(result.current[0]).toEqual([]);
    act(() => updateOriginal([attachment]));
    rerender(initialProps);
    expect(result.current[0]).toEqual([]);
    act(() => updateOriginal([attachment]));
    expect(result.current[0]).toEqual([]);
  });
});
