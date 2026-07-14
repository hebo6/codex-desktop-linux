import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { ServerId } from "../configuration";
import type {
  BindWindowServerRequest,
  UpdateWindowSessionRequest,
  WindowState,
} from "../transport/windowState";
import {
  useWindowState,
  WINDOW_STATE_ERROR_SUMMARY,
  WindowStateController,
  WindowStateControllerError,
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

function state(
  version: number,
  overrides: Partial<WindowState> = {},
): WindowState {
  return {
    windowId: "main",
    version,
    updatedAtMs: 1_000 + version,
    ...overrides,
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
    expect(loader).toHaveBeenCalledTimes(1);

    const loaded = state(4, { serverId: SERVER_A });
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

  it("重载只接受最新结果", async () => {
    const first = deferred<WindowState>();
    const second = deferred<WindowState>();
    const loader = vi
      .fn<() => Promise<WindowState>>()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const controller = new WindowStateController({ loader });

    controller.retain();
    controller.reload();
    expect(loader).toHaveBeenCalledTimes(2);

    const latest = state(2, { serverId: SERVER_B });
    second.resolve(latest);
    await second.promise;
    await Promise.resolve();
    expect(controller.getSnapshot().windowState).toBe(latest);

    first.resolve(state(1, { serverId: SERVER_A }));
    await first.promise;
    await Promise.resolve();
    expect(controller.getSnapshot()).toEqual({
      status: "ready",
      windowState: latest,
      error: null,
    });
  });

  it("bind 隐藏窗口标识并使用当前权威版本", async () => {
    const pendingLoad = deferred<WindowState>();
    const pendingBind = deferred<WindowState>();
    const binder = vi.fn(
      (_request: BindWindowServerRequest) => pendingBind.promise,
    );
    const controller = new WindowStateController({
      loader: () => pendingLoad.promise,
      binder,
    });
    await loadController(controller, pendingLoad, state(7));

    const operation = controller.bindServer(SERVER_A);
    expect(controller.getSnapshot()).toMatchObject({
      status: "updating",
      error: null,
    });
    await Promise.resolve();
    expect(binder).toHaveBeenCalledWith({
      expectedVersion: 7,
      serverId: SERVER_A,
    });
    expect(JSON.stringify(binder.mock.calls)).not.toContain("windowId");

    const bound = state(8, {
      serverId: SERVER_A,
      currentThreadId: "thread-a",
      draftKey: "draft-a",
    });
    pendingBind.resolve(bound);
    await expect(operation).resolves.toBe(bound);
    expect(controller.getSnapshot()).toEqual({
      status: "ready",
      windowState: bound,
      error: null,
    });
  });

  it("并发 bind 串行化并让后一项使用前一响应版本", async () => {
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
    await loadController(controller, pendingLoad, state(1));

    const firstOperation = controller.bindServer(SERVER_A);
    const secondOperation = controller.bindServer(SERVER_B);
    await Promise.resolve();
    expect(binder).toHaveBeenCalledTimes(1);
    expect(binder).toHaveBeenNthCalledWith(1, {
      expectedVersion: 1,
      serverId: SERVER_A,
    });

    const firstResult = state(2, { serverId: SERVER_A });
    firstBind.resolve(firstResult);
    await firstOperation;
    await waitFor(() => expect(binder).toHaveBeenCalledTimes(2));
    expect(binder).toHaveBeenNthCalledWith(2, {
      expectedVersion: 2,
      serverId: SERVER_B,
    });
    expect(controller.getSnapshot().status).toBe("updating");

    const secondResult = state(3, { serverId: SERVER_B });
    secondBind.resolve(secondResult);
    await expect(secondOperation).resolves.toBe(secondResult);
    expect(controller.getSnapshot()).toEqual({
      status: "ready",
      windowState: secondResult,
      error: null,
    });
  });

  it("相同服务器和相同会话直接返回当前状态且不进入 updating", async () => {
    const pendingLoad = deferred<WindowState>();
    const binder = vi.fn();
    const sessionUpdater = vi.fn();
    const current = state(7, {
      serverId: SERVER_A,
      currentThreadId: "thread-a",
      draftKey: "draft-a",
    });
    const controller = new WindowStateController({
      loader: () => pendingLoad.promise,
      binder,
      sessionUpdater,
    });
    await loadController(controller, pendingLoad, current);
    const listener = vi.fn();
    controller.subscribe(listener);

    await expect(controller.bindServer(SERVER_A)).resolves.toBe(current);
    await expect(controller.updateSession("thread-a", "draft-a")).resolves.toBe(
      current,
    );

    expect(binder).not.toHaveBeenCalled();
    expect(sessionUpdater).not.toHaveBeenCalled();
    expect(listener).not.toHaveBeenCalled();
    expect(controller.getSnapshot()).toEqual({
      status: "ready",
      windowState: current,
      error: null,
    });
  });

  it("排队操作在执行时重新判断幂等并避免多余命令", async () => {
    const pendingLoad = deferred<WindowState>();
    const firstBind = deferred<WindowState>();
    const binder = vi.fn(() => firstBind.promise);
    const controller = new WindowStateController({
      loader: () => pendingLoad.promise,
      binder,
    });
    await loadController(controller, pendingLoad, state(1));

    const first = controller.bindServer(SERVER_A);
    const duplicate = controller.bindServer(SERVER_A);
    await Promise.resolve();
    const bound = state(2, { serverId: SERVER_A });
    firstBind.resolve(bound);

    await expect(first).resolves.toBe(bound);
    await expect(duplicate).resolves.toBe(bound);
    expect(binder).toHaveBeenCalledTimes(1);
    expect(controller.getSnapshot()).toEqual({
      status: "ready",
      windowState: bound,
      error: null,
    });
  });

  it("updateSession 使用最新版本并保留当前服务器", async () => {
    const pendingLoad = deferred<WindowState>();
    const pendingUpdate = deferred<WindowState>();
    const sessionUpdater = vi.fn(
      (_request: UpdateWindowSessionRequest) => pendingUpdate.promise,
    );
    const controller = new WindowStateController({
      loader: () => pendingLoad.promise,
      sessionUpdater,
    });
    await loadController(
      controller,
      pendingLoad,
      state(5, { serverId: SERVER_A }),
    );

    const operation = controller.updateSession("thread-a", "draft-a");
    await Promise.resolve();
    expect(sessionUpdater).toHaveBeenCalledWith({
      expectedVersion: 5,
      currentThreadId: "thread-a",
      draftKey: "draft-a",
    });

    const updated = state(6, {
      serverId: SERVER_A,
      currentThreadId: "thread-a",
      draftKey: "draft-a",
    });
    pendingUpdate.resolve(updated);
    await expect(operation).resolves.toBe(updated);
    expect(controller.getSnapshot().windowState).toBe(updated);
  });

  it("拒绝窗口、版本、时间或更新字段不相关的结果并失效本地版本", async () => {
    const invalidResults: WindowState[] = [
      { ...state(2, { serverId: SERVER_A }), windowId: "another" },
      state(3, { serverId: SERVER_A }),
      { ...state(2, { serverId: SERVER_A }), updatedAtMs: 1 },
      state(2, { serverId: SERVER_B }),
    ];

    for (const invalid of invalidResults) {
      const pendingLoad = deferred<WindowState>();
      const binder = vi.fn(async () => invalid);
      const controller = new WindowStateController({
        loader: () => pendingLoad.promise,
        binder,
      });
      await loadController(controller, pendingLoad, state(1));

      await expect(controller.bindServer(SERVER_A)).rejects.toBeInstanceOf(
        WindowStateControllerError,
      );
      expect(controller.getSnapshot()).toEqual({
        status: "error",
        windowState: state(1),
        error: WINDOW_STATE_ERROR_SUMMARY,
      });
      await expect(controller.bindServer(SERVER_A)).rejects.toMatchObject({
        code: "stateUnavailable",
      });
      expect(binder).toHaveBeenCalledTimes(1);
    }
  });

  it("一次失败会阻止已排队写入继续使用不确定版本", async () => {
    const pendingLoad = deferred<WindowState>();
    const firstBind = deferred<WindowState>();
    const binder = vi.fn(() => firstBind.promise);
    const controller = new WindowStateController({
      loader: () => pendingLoad.promise,
      binder,
    });
    await loadController(controller, pendingLoad, state(1));

    const first = controller.bindServer(SERVER_A);
    const queued = controller.bindServer(SERVER_B);
    const settled = Promise.allSettled([first, queued]);
    firstBind.reject(new Error("DO_NOT_REPORT uncertain backend state"));
    const outcomes = await settled;

    expect(outcomes.map((outcome) => outcome.status)).toEqual([
      "rejected",
      "rejected",
    ]);
    expect(binder).toHaveBeenCalledTimes(1);
    expect(controller.getSnapshot()).toMatchObject({
      status: "error",
      error: WINDOW_STATE_ERROR_SUMMARY,
    });
    expect(JSON.stringify(controller.getSnapshot())).not.toContain(
      "DO_NOT_REPORT",
    );
  });

  it("失败后 reload 才能建立新权威版本", async () => {
    const firstLoad = deferred<WindowState>();
    const secondLoad = deferred<WindowState>();
    const loader = vi
      .fn<() => Promise<WindowState>>()
      .mockReturnValueOnce(firstLoad.promise)
      .mockReturnValueOnce(secondLoad.promise);
    const binder = vi.fn(async () => {
      throw new Error("failed");
    });
    const controller = new WindowStateController({ loader, binder });
    await loadController(controller, firstLoad, state(1));
    await expect(controller.bindServer(SERVER_A)).rejects.toBeInstanceOf(
      WindowStateControllerError,
    );

    controller.reload();
    expect(controller.getSnapshot().status).toBe("loading");
    const refreshed = state(9, { serverId: SERVER_B });
    secondLoad.resolve(refreshed);
    await secondLoad.promise;
    await Promise.resolve();
    expect(controller.getSnapshot()).toEqual({
      status: "ready",
      windowState: refreshed,
      error: null,
    });
  });

  it("未加载或已释放时不调用写命令", async () => {
    const binder = vi.fn();
    const controller = new WindowStateController({ binder });

    await expect(controller.bindServer(SERVER_A)).rejects.toMatchObject({
      code: "stateUnavailable",
    });
    controller.dispose();
    await expect(controller.bindServer(SERVER_A)).rejects.toMatchObject({
      code: "stateUnavailable",
    });
    expect(binder).not.toHaveBeenCalled();
  });

  it("dispose 后忽略迟到的加载和写入结果", async () => {
    const pendingLoad = deferred<WindowState>();
    const controller = new WindowStateController({
      loader: () => pendingLoad.promise,
    });
    const listener = vi.fn();
    controller.subscribe(listener);
    controller.retain();
    const callsBeforeDispose = listener.mock.calls.length;
    controller.dispose();

    pendingLoad.resolve(state(1, { serverId: SERVER_A }));
    await pendingLoad.promise;
    await Promise.resolve();
    expect(listener).toHaveBeenCalledTimes(callsBeforeDispose);
    expect(controller.getSnapshot().status).toBe("loading");
  });
});

describe("useWindowState", () => {
  it("挂载时自动加载并暴露稳定控制函数", async () => {
    const pending = deferred<WindowState>();
    const loader = vi.fn(() => pending.promise);
    const { result, rerender, unmount } = renderHook(() =>
      useWindowState({ loader }),
    );

    expect(result.current).toMatchObject({
      status: "loading",
      windowState: null,
      error: null,
    });
    const controls = {
      reload: result.current.reload,
      bindServer: result.current.bindServer,
      updateSession: result.current.updateSession,
    };

    const loaded = state(1, { serverId: SERVER_A });
    await act(async () => {
      pending.resolve(loaded);
      await pending.promise;
    });
    expect(result.current).toMatchObject({
      status: "ready",
      windowState: loaded,
      error: null,
    });
    rerender();
    expect(result.current.reload).toBe(controls.reload);
    expect(result.current.bindServer).toBe(controls.bindServer);
    expect(result.current.updateSession).toBe(controls.updateSession);
    unmount();
  });

  it("StrictMode 式 effect 清理不会重复首载或提前释放", async () => {
    const pending = deferred<WindowState>();
    const loader = vi.fn(() => pending.promise);
    const { result, unmount } = renderHook(() => useWindowState({ loader }), {
      reactStrictMode: true,
    });

    expect(loader).toHaveBeenCalledTimes(1);
    await act(async () => {
      pending.resolve(state(1));
      await pending.promise;
    });
    expect(result.current.status).toBe("ready");
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
      first.reject(new Error("DO_NOT_REPORT database details"));
      await first.promise.catch(() => undefined);
    });
    expect(result.current).toMatchObject({
      status: "error",
      error: WINDOW_STATE_ERROR_SUMMARY,
    });
    expect(JSON.stringify(result.current)).not.toContain("DO_NOT_REPORT");

    act(() => result.current.reload());
    await act(async () => {
      second.resolve(state(2));
      await second.promise;
    });
    expect(result.current.status).toBe("ready");
    unmount();
  });

  it("卸载后忽略仍在进行的 bind 结果", async () => {
    const pendingBind = deferred<WindowState>();
    const loaded = state(1);
    const { result, unmount } = renderHook(() =>
      useWindowState({
        loader: async () => loaded,
        binder: () => pendingBind.promise,
      }),
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    let operation!: Promise<WindowState>;
    act(() => {
      operation = result.current.bindServer(SERVER_A);
    });
    expect(result.current.status).toBe("updating");
    unmount();
    const bound = state(2, { serverId: SERVER_A });
    pendingBind.resolve(bound);
    await expect(operation).resolves.toBe(bound);
    expect(result.current.status).toBe("updating");
  });
});
