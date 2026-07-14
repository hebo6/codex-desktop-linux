import { describe, expect, it, vi } from "vitest";

import type { ServerId } from "../configuration";
import {
  bindWindowServer,
  loadWindowState,
  openAppWindow,
  subscribeWindowServerReferenceChanges,
  updateWindowSession,
  WindowStateTransportError,
} from "./windowState";
import type { WindowStateEventApi, WindowStateIpc } from "./windowState";

const SERVER_A = "11111111-1111-4111-8111-111111111111" as ServerId;
const SERVER_B = "22222222-2222-4222-8222-222222222222" as ServerId;

interface IpcCall {
  readonly command: string;
  readonly arguments: Record<string, unknown>;
}

class FakeIpc implements WindowStateIpc {
  readonly calls: IpcCall[] = [];
  readonly responses = new Map<string, unknown>();
  readonly failures = new Map<string, unknown>();

  invoke<T>(command: string, arguments_: Record<string, unknown>): Promise<T> {
    this.calls.push({ command, arguments: arguments_ });
    if (this.failures.has(command)) {
      return Promise.reject(this.failures.get(command));
    }
    return Promise.resolve(this.responses.get(command) as T);
  }
}

class FakeEvents implements WindowStateEventApi {
  eventName: string | null = null;
  handler: ((event: { readonly payload: unknown }) => void) | null = null;
  readonly unlisten = vi.fn();

  async listen(
    event: string,
    handler: (event: { readonly payload: unknown }) => void,
  ): Promise<() => void> {
    this.eventName = event;
    this.handler = handler;
    return this.unlisten;
  }
}

function windowState(overrides: Record<string, unknown> = {}) {
  return {
    windowId: "main",
    version: 1,
    updatedAtMs: 1_000,
    ...overrides,
  };
}

describe("windowState transport", () => {
  it("只订阅严格的活动窗口引用变化事件并返回取消函数", async () => {
    const events = new FakeEvents();
    const onChange = vi.fn();
    const unlisten = await subscribeWindowServerReferenceChanges(
      onChange,
      events,
    );

    expect(events.eventName).toBe("window-server-references-changed");
    events.handler?.({ payload: null });
    events.handler?.({ payload: { extra: true } });
    expect(onChange).not.toHaveBeenCalled();
    events.handler?.({ payload: {} });
    expect(onChange).toHaveBeenCalledTimes(1);
    unlisten();
    expect(events.unlisten).toHaveBeenCalledTimes(1);
  });

  it("窗口引用事件监听器异常不会阻断后续事件", async () => {
    const events = new FakeEvents();
    const onChange = vi
      .fn()
      .mockImplementationOnce(() => {
        throw new Error("view closed");
      })
      .mockImplementationOnce(() => undefined);
    await subscribeWindowServerReferenceChanges(onChange, events);

    expect(() => events.handler?.({ payload: {} })).not.toThrow();
    expect(() => events.handler?.({ payload: {} })).not.toThrow();
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it("无参数加载当前调用窗口状态并接受缺省的可选字段", async () => {
    const ipc = new FakeIpc();
    ipc.responses.set("load_window_state", windowState());

    const state = await loadWindowState(ipc);

    expect(state).toEqual({
      windowId: "main",
      version: 1,
      updatedAtMs: 1_000,
    });
    expect(Object.isFrozen(state)).toBe(true);
    expect(ipc.calls).toEqual([
      { command: "load_window_state", arguments: {} },
    ]);
    expect(JSON.stringify(ipc.calls)).not.toContain("windowId");
  });

  it("严格解析完整窗口状态", async () => {
    const ipc = new FakeIpc();
    ipc.responses.set(
      "load_window_state",
      windowState({
        windowId: "0198a708-8c47-7e56-8458-155a60c8945c",
        version: Number.MAX_SAFE_INTEGER,
        serverId: SERVER_A,
        currentThreadId: "线程-1",
        draftKey: "草稿-1",
        updatedAtMs: Number.MAX_SAFE_INTEGER,
      }),
    );

    await expect(loadWindowState(ipc)).resolves.toEqual({
      windowId: "0198a708-8c47-7e56-8458-155a60c8945c",
      version: Number.MAX_SAFE_INTEGER,
      serverId: SERVER_A,
      currentThreadId: "线程-1",
      draftKey: "草稿-1",
      updatedAtMs: Number.MAX_SAFE_INTEGER,
    });
  });

  it("按期望版本绑定或清空服务器且请求中不存在 windowId", async () => {
    const ipc = new FakeIpc();
    ipc.responses.set(
      "bind_window_server",
      windowState({
        version: 8,
        serverId: SERVER_A,
        currentThreadId: "thread-a",
        draftKey: "draft-a",
        updatedAtMs: 1_001,
      }),
    );

    await expect(
      bindWindowServer({ expectedVersion: 7, serverId: SERVER_A }, ipc),
    ).resolves.toMatchObject({ version: 8, serverId: SERVER_A });
    expect(ipc.calls[0]).toEqual({
      command: "bind_window_server",
      arguments: {
        request: { expectedVersion: 7, serverId: SERVER_A },
      },
    });
    expect(JSON.stringify(ipc.calls[0])).not.toContain("windowId");

    ipc.responses.set(
      "bind_window_server",
      windowState({ version: 9, updatedAtMs: 1_002 }),
    );
    await expect(
      bindWindowServer({ expectedVersion: 8, serverId: null }, ipc),
    ).resolves.toEqual(windowState({ version: 9, updatedAtMs: 1_002 }));
    expect(ipc.calls[1]?.arguments).toEqual({
      request: { expectedVersion: 8, serverId: null },
    });

    ipc.responses.set(
      "bind_window_server",
      windowState({ version: 9, serverId: SERVER_A, updatedAtMs: 1_003 }),
    );
    await expect(
      bindWindowServer({ expectedVersion: 9, serverId: SERVER_A }, ipc),
    ).resolves.toMatchObject({ version: 9, serverId: SERVER_A });
  });

  it("显式传递 nullable 会话字段并校验响应相关性", async () => {
    const ipc = new FakeIpc();
    ipc.responses.set(
      "update_window_session",
      windowState({
        version: 3,
        serverId: SERVER_A,
        currentThreadId: "thread-2",
        draftKey: "draft-2",
        updatedAtMs: 2_000,
      }),
    );

    await updateWindowSession(
      {
        expectedVersion: 2,
        currentThreadId: "thread-2",
        draftKey: "draft-2",
      },
      ipc,
    );
    expect(ipc.calls[0]).toEqual({
      command: "update_window_session",
      arguments: {
        request: {
          expectedVersion: 2,
          currentThreadId: "thread-2",
          draftKey: "draft-2",
        },
      },
    });

    ipc.responses.set(
      "update_window_session",
      windowState({ version: 4, serverId: SERVER_A, updatedAtMs: 2_001 }),
    );
    await expect(
      updateWindowSession(
        { expectedVersion: 3, currentThreadId: null, draftKey: null },
        ipc,
      ),
    ).resolves.toMatchObject({ version: 4 });
    expect(ipc.calls[1]?.arguments).toEqual({
      request: {
        expectedVersion: 3,
        currentThreadId: null,
        draftKey: null,
      },
    });

    ipc.responses.set(
      "update_window_session",
      windowState({
        version: 5,
        currentThreadId: "wrong-thread",
        updatedAtMs: 2_002,
      }),
    );
    await expect(
      updateWindowSession(
        { expectedVersion: 4, currentThreadId: null, draftKey: null },
        ipc,
      ),
    ).rejects.toMatchObject({ code: "invalidResponse" });

    ipc.responses.set(
      "update_window_session",
      windowState({
        version: 5,
        serverId: SERVER_A,
        currentThreadId: "thread-5",
        draftKey: "draft-5",
        updatedAtMs: 2_003,
      }),
    );
    await expect(
      updateWindowSession(
        {
          expectedVersion: 5,
          currentThreadId: "thread-5",
          draftKey: "draft-5",
        },
        ipc,
      ),
    ).resolves.toMatchObject({ version: 5 });
  });

  it("创建窗口可选择目标会话并校验稳定标签", async () => {
    const ipc = new FakeIpc();
    const windowId = "0198a708-8c47-7e56-8458-155a60c8945c";
    ipc.responses.set("open_app_window", {
      windowId,
      label: `app-${windowId}`,
    });

    await expect(openAppWindow({ serverId: SERVER_B }, ipc)).resolves.toEqual({
      windowId,
      label: `app-${windowId}`,
    });
    expect(ipc.calls).toEqual([
      {
        command: "open_app_window",
        arguments: { request: { serverId: SERVER_B } },
      },
    ]);

    await expect(
      openAppWindow({ serverId: SERVER_B, threadId: "thread-5" }, ipc),
    ).resolves.toEqual({ windowId, label: `app-${windowId}` });
    expect(ipc.calls.at(-1)).toEqual({
      command: "open_app_window",
      arguments: {
        request: { serverId: SERVER_B, threadId: "thread-5" },
      },
    });

    ipc.responses.set("open_app_window", {
      windowId,
      label: "app-another-window",
    });
    await expect(
      openAppWindow({ serverId: SERVER_B }, ipc),
    ).rejects.toMatchObject({ code: "invalidResponse" });
  });

  it("拒绝响应缺字段、多字段、错误标识、错误数值与 nullable 可选字段", async () => {
    const invalidStates: unknown[] = [
      { version: 1, updatedAtMs: 1 },
      { windowId: "main", updatedAtMs: 1 },
      { windowId: "main", version: 1 },
      windowState({ extra: true }),
      windowState({ windowId: "Main" }),
      windowState({ version: 0 }),
      windowState({ version: 1.5 }),
      windowState({ updatedAtMs: -1 }),
      windowState({ updatedAtMs: Number.MAX_SAFE_INTEGER + 1 }),
      windowState({ serverId: "not-a-server" }),
      windowState({ serverId: null }),
      windowState({ currentThreadId: null }),
      windowState({ draftKey: "" }),
      windowState({ currentThreadId: "thread-without-server" }),
      windowState({ draftKey: "draft-without-server" }),
      windowState({ serverId: SERVER_A, currentThreadId: "nul\0thread" }),
      windowState({ serverId: SERVER_A, draftKey: "nul\0draft" }),
      windowState({ currentThreadId: "中".repeat(342) }),
      windowState({ draftKey: "中".repeat(86) }),
      [],
      null,
    ];

    for (const invalid of invalidStates) {
      const ipc = new FakeIpc();
      ipc.responses.set("load_window_state", invalid);
      await expect(loadWindowState(ipc)).rejects.toBeInstanceOf(
        WindowStateTransportError,
      );
    }
  });

  it("按 UTF-8 字节限制会话字段并拒绝请求字段缺失或额外字段", async () => {
    const ipc = new FakeIpc();
    ipc.responses.set(
      "update_window_session",
      windowState({
        version: 2,
        serverId: SERVER_A,
        currentThreadId: "中".repeat(341),
        draftKey: "中".repeat(85),
        updatedAtMs: 2,
      }),
    );
    await expect(
      updateWindowSession(
        {
          expectedVersion: 1,
          currentThreadId: "中".repeat(341),
          draftKey: "中".repeat(85),
        },
        ipc,
      ),
    ).resolves.toMatchObject({ version: 2 });

    const invalidRequests: unknown[] = [
      { expectedVersion: 1, currentThreadId: null },
      { expectedVersion: 1, draftKey: null },
      { currentThreadId: null, draftKey: null },
      {
        expectedVersion: 1,
        currentThreadId: null,
        draftKey: null,
        windowId: "main",
      },
      {
        expectedVersion: 1,
        currentThreadId: "中".repeat(342),
        draftKey: null,
      },
      {
        expectedVersion: 1,
        currentThreadId: null,
        draftKey: "中".repeat(86),
      },
      { expectedVersion: 1, currentThreadId: "", draftKey: null },
      { expectedVersion: 1, currentThreadId: "nul\0thread", draftKey: null },
      { expectedVersion: 1, currentThreadId: null, draftKey: "nul\0draft" },
    ];
    for (const invalid of invalidRequests) {
      await expect(
        updateWindowSession(invalid as never, ipc),
      ).rejects.toMatchObject({ code: "invalidRequest" });
    }
  });

  it("拒绝 bind/open 请求中的缺失、额外或无效字段且不调用 IPC", async () => {
    const ipc = new FakeIpc();
    const bindRequests: unknown[] = [
      { serverId: SERVER_A },
      { expectedVersion: 1 },
      { expectedVersion: 0, serverId: SERVER_A },
      { expectedVersion: 1, serverId: "invalid" },
      { expectedVersion: 1, serverId: SERVER_A, windowId: "main" },
    ];
    for (const request of bindRequests) {
      await expect(
        bindWindowServer(request as never, ipc),
      ).rejects.toMatchObject({ code: "invalidRequest" });
    }
    const openRequests: unknown[] = [
      {},
      { serverId: null },
      { serverId: "invalid" },
      { serverId: SERVER_A, threadId: null },
      { serverId: SERVER_A, threadId: "" },
      { serverId: SERVER_A, threadId: "nul\0thread" },
      { serverId: SERVER_A, threadId: "中".repeat(342) },
      { serverId: SERVER_A, windowId: "main" },
    ];
    for (const request of openRequests) {
      await expect(openAppWindow(request as never, ipc)).rejects.toMatchObject({
        code: "invalidRequest",
      });
    }
    expect(ipc.calls).toHaveLength(0);
  });

  it("拒绝 bind/update 的错误版本或字段响应", async () => {
    const ipc = new FakeIpc();
    ipc.responses.set(
      "bind_window_server",
      windowState({ version: 7, serverId: SERVER_B }),
    );
    await expect(
      bindWindowServer({ expectedVersion: 7, serverId: SERVER_A }, ipc),
    ).rejects.toMatchObject({ code: "invalidResponse" });

    ipc.responses.set(
      "bind_window_server",
      windowState({ version: 8, serverId: SERVER_B }),
    );
    await expect(
      bindWindowServer({ expectedVersion: 7, serverId: SERVER_A }, ipc),
    ).rejects.toMatchObject({ code: "invalidResponse" });
  });

  it("将未知命令错误收敛为固定错误且不泄露后端正文", async () => {
    const ipc = new FakeIpc();
    ipc.failures.set("load_window_state", {
      code: "unknown",
      message: "DO_NOT_REPORT database path and SQL",
    });

    const error = await loadWindowState(ipc).catch(
      (failure: unknown) => failure,
    );

    expect(error).toBeInstanceOf(WindowStateTransportError);
    expect(error).toMatchObject({ code: "commandFailed" });
    expect(JSON.stringify(error)).not.toContain("DO_NOT_REPORT");
  });

  it("即使 IPC 同步抛错也只返回安全命令错误", async () => {
    const invoke = vi.fn(() => {
      throw new Error("DO_NOT_REPORT synchronous error");
    });

    await expect(loadWindowState({ invoke })).rejects.toMatchObject({
      code: "commandFailed",
    });
  });
});
