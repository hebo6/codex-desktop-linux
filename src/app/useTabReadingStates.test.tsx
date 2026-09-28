import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { useTabReadingStates } from "./useTabReadingStates";

interface HookProps {
  readonly serverId: string | null;
  readonly tabs: readonly { readonly id: string; readonly threadId: string | null }[];
}

function renderReadingStates(initialProps: HookProps) {
  return renderHook(({ serverId, tabs }: HookProps) =>
    useTabReadingStates(serverId, tabs),
  { initialProps });
}

describe("useTabReadingStates", () => {
  it("切换、重排和新增标签时保留已有会话的阅读存储", () => {
    const initialProps: HookProps = {
      serverId: "server",
      tabs: [
        { id: "tab-a", threadId: "thread-a" },
        { id: "tab-b", threadId: "thread-b" },
      ],
    };
    const { result, rerender } = renderReadingStates(initialProps);
    const originalMap = result.current;
    const storeA = result.current.get("tab-a");
    const storeB = result.current.get("tab-b");
    expect(storeA).toEqual({ current: null });
    expect(storeB).toEqual({ current: null });
    expect(storeA).not.toBe(storeB);

    rerender(initialProps);
    expect(result.current).toBe(originalMap);

    rerender({ ...initialProps, tabs: [...initialProps.tabs].reverse() });
    expect(result.current.get("tab-a")).toBe(storeA);
    expect(result.current.get("tab-b")).toBe(storeB);

    rerender({
      ...initialProps,
      tabs: [...initialProps.tabs, { id: "tab-c", threadId: "thread-c" }],
    });
    expect(result.current.get("tab-a")).toBe(storeA);
    expect(result.current.get("tab-b")).toBe(storeB);
    expect(result.current.get("tab-c")).toEqual({ current: null });
  });

  it("空白标签不创建存储，绑定会话后创建并在再次清空时丢弃", () => {
    const initialProps: HookProps = {
      serverId: null,
      tabs: [{ id: "tab", threadId: null }],
    };
    const { result, rerender } = renderReadingStates(initialProps);
    expect(result.current.size).toBe(0);

    const boundProps: HookProps = {
      serverId: "server",
      tabs: [{ id: "tab", threadId: "thread" }],
    };
    rerender(boundProps);
    const original = result.current.get("tab");
    expect(original).toEqual({ current: null });

    rerender({ ...boundProps, tabs: initialProps.tabs });
    expect(result.current.size).toBe(0);
    rerender(boundProps);
    expect(result.current.get("tab")).toEqual({ current: null });
    expect(result.current.get("tab")).not.toBe(original);
  });

  it("替换会话时只重建对应标签的存储，换回原会话也不恢复旧存储", () => {
    const initialProps: HookProps = {
      serverId: "server",
      tabs: [
        { id: "tab-a", threadId: "thread-a" },
        { id: "tab-b", threadId: "thread-b" },
      ],
    };
    const { result, rerender } = renderReadingStates(initialProps);
    const storeA = result.current.get("tab-a");
    const storeB = result.current.get("tab-b");

    rerender({
      ...initialProps,
      tabs: [
        { id: "tab-a", threadId: "other-thread" },
        initialProps.tabs[1]!,
      ],
    });
    const replacement = result.current.get("tab-a");
    expect(replacement).toEqual({ current: null });
    expect(replacement).not.toBe(storeA);
    expect(result.current.get("tab-b")).toBe(storeB);

    rerender(initialProps);
    expect(result.current.get("tab-a")).not.toBe(storeA);
    expect(result.current.get("tab-a")).not.toBe(replacement);
    expect(result.current.get("tab-b")).toBe(storeB);
  });

  it("关闭标签后删除存储，再次打开同一标签和会话时重新创建", () => {
    const initialProps: HookProps = {
      serverId: "server",
      tabs: [
        { id: "tab-a", threadId: "thread-a" },
        { id: "tab-b", threadId: "thread-b" },
      ],
    };
    const { result, rerender } = renderReadingStates(initialProps);
    const storeA = result.current.get("tab-a");
    const storeB = result.current.get("tab-b");

    rerender({ ...initialProps, tabs: [initialProps.tabs[1]!] });
    expect(result.current.has("tab-a")).toBe(false);
    expect(result.current.get("tab-b")).toBe(storeB);

    rerender(initialProps);
    expect(result.current.get("tab-a")).toEqual({ current: null });
    expect(result.current.get("tab-a")).not.toBe(storeA);
    expect(result.current.get("tab-b")).toBe(storeB);
  });

  it.each(["other-server", null])(
    "切换服务器到 %s 后丢弃所有旧存储，换回时重新创建",
    (serverId) => {
      const initialProps: HookProps = {
        serverId: "server",
        tabs: [{ id: "tab", threadId: "thread" }],
      };
      const { result, rerender } = renderReadingStates(initialProps);
      const original = result.current.get("tab");

      rerender({ ...initialProps, serverId });
      const replacement = result.current.get("tab");
      expect(replacement).toEqual({ current: null });
      expect(replacement).not.toBe(original);

      rerender(initialProps);
      expect(result.current.get("tab")).not.toBe(original);
      expect(result.current.get("tab")).not.toBe(replacement);
    },
  );
});
