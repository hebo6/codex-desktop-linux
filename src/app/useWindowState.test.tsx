import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { ServerId } from "../configuration";
import {
  WindowStateTransportError,
  type BindWindowServerRequest,
  type UpdateWindowTabsRequest,
  type WindowState,
  type WindowTab,
} from "../transport/windowState";
import {
  useWindowState,
  WINDOW_STATE_ERROR_SUMMARY,
  WindowStateController,
} from "./useWindowState";

const SERVER_A = "11111111-1111-4111-8111-111111111111" as ServerId;
const SERVER_B = "22222222-2222-4222-8222-222222222222" as ServerId;

interface Deferred<Value> {
  readonly promise: Promise<Value>;
  readonly resolve: (value: Value) => void;
  readonly reject: (reason: unknown) => void;
}

function deferred<Value>(): Deferred<Value> {
  let resolve!: (value: Value) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<Value>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function unboundState(version: number): WindowState {
  return {
    windowId: "main",
    version,
    tabs: [],
    updatedAtMs: 1_000 + version,
  };
}

function boundState(
  version: number,
  tabs: readonly WindowTab[] = [{ id: "tab-a", threadId: null }],
  activeTabId: string = tabs[0]?.id ?? "tab-a",
  serverId: ServerId = SERVER_A,
): WindowState {
  return {
    windowId: "main",
    version,
    serverId,
    tabs,
    activeTabId,
    updatedAtMs: 1_000 + version,
  };
}

async function loadController(
  controller: WindowStateController,
  pending: Deferred<WindowState>,
  loaded: WindowState,
): Promise<void> {
  controller.retain();
  pending.resolve(loaded);
  await pending.promise;
  await Promise.resolve();
}

describe("WindowStateController", () => {
  it("首载成功后发布权威窗口状态", async () => {
    const pending = deferred<WindowState>();
    const loader = vi.fn(() => pending.promise);
    const controller = new WindowStateController({ loader });

    const release = controller.retain();
    expect(controller.getSnapshot()).toEqual({
      status: "loading",
      windowState: null,
      error: null,
    });

    const loaded = boundState(4);
    pending.resolve(loaded);
    await pending.promise;
    await Promise.resolve();

    expect(controller.getSnapshot()).toEqual({
      status: "ready",
      windowState: loaded,
      error: null,
    });
    release();
  });

  it("bind 串行化并让后一项使用前一响应版本", async () => {
    const pendingLoad = deferred<WindowState>();
    const firstBind = deferred<WindowState>();
    const secondBind = deferred<WindowState>();
    const binder = vi
      .fn<(request: BindWindowServerRequest) => Promise<WindowState>>()
      .mockReturnValueOnce(firstBind.promise)
      .mockReturnValueOnce(secondBind.promise);
    const controller = new WindowStateController({
      loader: () => pendingLoad.promise,
      binder,
    });
    await loadController(controller, pendingLoad, unboundState(1));

    const first = controller.bindServer(SERVER_A);
    const second = controller.bindServer(SERVER_B);
    await Promise.resolve();
    expect(binder).toHaveBeenNthCalledWith(1, {
      expectedVersion: 1,
      serverId: SERVER_A,
    });

    firstBind.resolve(boundState(2));
    await first;
    await waitFor(() => expect(binder).toHaveBeenCalledTimes(2));
    expect(binder).toHaveBeenNthCalledWith(2, {
      expectedVersion: 2,
      serverId: SERVER_B,
    });

    const secondState = boundState(3, undefined, undefined, SERVER_B);
    secondBind.resolve(secondState);
    await expect(second).resolves.toBe(secondState);
  });

  it("替换、新建、激活、绑定和关闭标签都提交完整标签集合", async () => {
    const pendingLoad = deferred<WindowState>();
    let authoritative = boundState(1);
    const requests: UpdateWindowTabsRequest[] = [];
    const tabsUpdater = vi.fn(async (request: UpdateWindowTabsRequest) => {
      requests.push(request);
      authoritative = {
        ...authoritative,
        version: authoritative.version + 1,
        updatedAtMs: authoritative.updatedAtMs + 1,
        tabs: request.tabs,
        activeTabId: request.activeTabId,
      };
      return authoritative;
    });
    const controller = new WindowStateController({
      loader: () => pendingLoad.promise,
      tabsUpdater,
    });
    await loadController(controller, pendingLoad, authoritative);

    await controller.replaceActiveThread("thread-a");
    expect(requests.at(-1)).toEqual({
      expectedVersion: 1,
      tabs: [{ id: "tab-a", threadId: "thread-a" }],
      activeTabId: "tab-a",
    });

    const opened = await controller.openTab("thread-b");
    const openedTab = opened.tabs.find(({ threadId }) => threadId === "thread-b");
    expect(openedTab).toBeDefined();
    expect(opened.activeTabId).toBe(openedTab?.id);

    await controller.activateTab("tab-a");
    expect(requests.at(-1)?.activeTabId).toBe("tab-a");

    await controller.closeTab("tab-a");
    expect(authoritative.tabs).toHaveLength(1);
    expect(authoritative.tabs[0]?.threadId).toBe("thread-b");

    await controller.replaceActiveThread(null);
    await controller.attachThread(authoritative.activeTabId!, "thread-c");
    expect(authoritative.tabs[0]?.threadId).toBe("thread-c");
  });

  it("打开已经存在的会话只激活标签且不重复创建", async () => {
    const pendingLoad = deferred<WindowState>();
    const current = boundState(
      3,
      [
        { id: "tab-a", threadId: "thread-a" },
        { id: "tab-b", threadId: "thread-b" },
      ],
      "tab-a",
    );
    const tabsUpdater = vi.fn(async (request: UpdateWindowTabsRequest) => ({
      ...current,
      version: 4,
      tabs: request.tabs,
      activeTabId: request.activeTabId,
      updatedAtMs: 1_004,
    }));
    const controller = new WindowStateController({
      loader: () => pendingLoad.promise,
      tabsUpdater,
    });
    await loadController(controller, pendingLoad, current);

    const next = await controller.openTab("thread-b");

    expect(tabsUpdater).toHaveBeenCalledWith({
      expectedVersion: 3,
      tabs: current.tabs,
      activeTabId: "tab-b",
    });
    expect(next.tabs).toHaveLength(2);
  });

  it("从中间标签打开新标签时追加到标签栏末尾", async () => {
    const pendingLoad = deferred<WindowState>();
    const current = boundState(
      2,
      [
        { id: "tab-a", threadId: "thread-a" },
        { id: "tab-b", threadId: "thread-b" },
        { id: "tab-c", threadId: "thread-c" },
      ],
      "tab-b",
    );
    const tabsUpdater = vi.fn(async (request: UpdateWindowTabsRequest) => ({
      ...current,
      version: 3,
      tabs: request.tabs,
      activeTabId: request.activeTabId,
      updatedAtMs: 1_003,
    }));
    const controller = new WindowStateController({
      loader: () => pendingLoad.promise,
      tabsUpdater,
    });
    await loadController(controller, pendingLoad, current);

    const next = await controller.openTab("thread-d");

    expect(next.tabs.map(({ threadId }) => threadId)).toEqual([
      "thread-a",
      "thread-b",
      "thread-c",
      "thread-d",
    ]);
    expect(next.activeTabId).toBe(next.tabs.at(-1)?.id);
  });

  it("关闭最后一个标签时创建新的空白标签", async () => {
    const pendingLoad = deferred<WindowState>();
    const current = boundState(
      1,
      [{ id: "tab-only", threadId: "thread-a" }],
      "tab-only",
    );
    const tabsUpdater = vi.fn(async (request: UpdateWindowTabsRequest) => ({
      ...current,
      version: 2,
      tabs: request.tabs,
      activeTabId: request.activeTabId,
      updatedAtMs: 1_002,
    }));
    const controller = new WindowStateController({
      loader: () => pendingLoad.promise,
      tabsUpdater,
    });
    await loadController(controller, pendingLoad, current);

    const next = await controller.closeTab("tab-only");

    expect(next.tabs).toHaveLength(1);
    expect(next.tabs[0]?.threadId).toBeNull();
    expect(next.activeTabId).toBe(next.tabs[0]?.id);
  });

  it("服务器已被其它窗口占用时保留当前权威状态", async () => {
    const pendingLoad = deferred<WindowState>();
    const current = unboundState(1);
    const binder = vi.fn(async () => {
      throw new WindowStateTransportError("serverAlreadyOpen");
    });
    const controller = new WindowStateController({
      loader: () => pendingLoad.promise,
      binder,
    });
    await loadController(controller, pendingLoad, current);

    await expect(controller.bindServer(SERVER_A)).rejects.toMatchObject({
      code: "serverAlreadyOpen",
    });
    expect(controller.getSnapshot()).toEqual({
      status: "ready",
      windowState: current,
      error: null,
    });
  });

  it("外部窗口状态事件只接受同一窗口的更新版本", async () => {
    const pendingLoad = deferred<WindowState>();
    const current = boundState(2);
    const controller = new WindowStateController({
      loader: () => pendingLoad.promise,
    });
    await loadController(controller, pendingLoad, current);

    controller.applyExternalState({ ...boundState(3), windowId: "other" });
    controller.applyExternalState(boundState(1));
    expect(controller.getSnapshot().windowState).toBe(current);

    const external = boundState(
      3,
      [{ id: "tab-external", threadId: "thread-external" }],
      "tab-external",
    );
    controller.applyExternalState(external);
    expect(controller.getSnapshot().windowState).toBe(external);
  });

  it("不确定写入失败后要求重新加载权威状态", async () => {
    const pendingLoad = deferred<WindowState>();
    const controller = new WindowStateController({
      loader: () => pendingLoad.promise,
      binder: async () => {
        throw new Error("DO_NOT_REPORT");
      },
    });
    await loadController(controller, pendingLoad, unboundState(1));

    await expect(controller.bindServer(SERVER_A)).rejects.toMatchObject({
      code: "operationFailed",
    });
    expect(controller.getSnapshot()).toMatchObject({
      status: "error",
      error: WINDOW_STATE_ERROR_SUMMARY,
    });
    expect(JSON.stringify(controller.getSnapshot())).not.toContain("DO_NOT_REPORT");
  });
});

describe("useWindowState", () => {
  it("挂载时自动加载并暴露稳定控制函数", async () => {
    const pending = deferred<WindowState>();
    const loader = vi.fn(() => pending.promise);
    const { result, rerender, unmount } = renderHook(() =>
      useWindowState({ loader }),
    );
    const controls = {
      reload: result.current.reload,
      bindServer: result.current.bindServer,
      openTab: result.current.openTab,
      activateTab: result.current.activateTab,
      closeTab: result.current.closeTab,
      attachThread: result.current.attachThread,
    };

    const loaded = boundState(1);
    await act(async () => {
      pending.resolve(loaded);
      await pending.promise;
    });
    rerender();

    expect(result.current.status).toBe("ready");
    expect(result.current.reload).toBe(controls.reload);
    expect(result.current.bindServer).toBe(controls.bindServer);
    expect(result.current.openTab).toBe(controls.openTab);
    expect(result.current.activateTab).toBe(controls.activateTab);
    expect(result.current.closeTab).toBe(controls.closeTab);
    expect(result.current.attachThread).toBe(controls.attachThread);
    unmount();
  });

  it("加载失败只暴露固定中文摘要并允许重试", async () => {
    const first = deferred<WindowState>();
    const second = deferred<WindowState>();
    const loader = vi
      .fn<() => Promise<WindowState>>()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const { result, unmount } = renderHook(() => useWindowState({ loader }));

    await act(async () => {
      first.reject(new Error("DO_NOT_REPORT"));
      await first.promise.catch(() => undefined);
    });
    expect(result.current).toMatchObject({
      status: "error",
      error: WINDOW_STATE_ERROR_SUMMARY,
    });

    act(() => result.current.reload());
    await act(async () => {
      second.resolve(unboundState(2));
      await second.promise;
    });
    expect(result.current.status).toBe("ready");
    unmount();
  });
});
