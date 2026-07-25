import { describe, expect, it, vi } from "vitest";

import type { ServerId } from "../configuration";
import {
  bindWindowServer,
  loadWindowState,
  openAppWindow,
  subscribeWindowServerReferenceChanges,
  subscribeWindowStateChanges,
  updateWindowTabs,
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

function unboundState(overrides: Record<string, unknown> = {}) {
  return {
    windowId: "main",
    version: 1,
    tabs: [],
    updatedAtMs: 1_000,
    ...overrides,
  };
}

function boundState(overrides: Record<string, unknown> = {}) {
  return {
    windowId: "main",
    version: 1,
    serverId: SERVER_A,
    tabs: [{ id: "tab-a", threadId: null }],
    activeTabId: "tab-a",
    updatedAtMs: 1_000,
    ...overrides,
  };
}

describe("windowState transport", () => {
  it("订阅严格的活动窗口引用变化事件", async () => {
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

  it("订阅并严格解析目标窗口标签状态", async () => {
    const events = new FakeEvents();
    const onChange = vi.fn();
    await subscribeWindowStateChanges(onChange, events);

    expect(events.eventName).toBe("window-state-changed");
    events.handler?.({ payload: { invalid: true } });
    expect(onChange).not.toHaveBeenCalled();
    events.handler?.({ payload: boundState({ version: 3 }) });
    expect(onChange).toHaveBeenCalledWith({
      ...boundState({ version: 3 }),
      tabs: Object.freeze([{ id: "tab-a", threadId: null }]),
    });
  });

  it("加载未绑定或包含多个标签的窗口状态", async () => {
    const ipc = new FakeIpc();
    ipc.responses.set("load_window_state", unboundState());
    await expect(loadWindowState(ipc)).resolves.toEqual(unboundState());

    ipc.responses.set("load_window_state", boundState({
      tabs: [
        { id: "tab-a", threadId: "线程-1" },
        { id: "tab-b", threadId: null },
      ],
      activeTabId: "tab-b",
    }));
    await expect(loadWindowState(ipc)).resolves.toMatchObject({
      serverId: SERVER_A,
      activeTabId: "tab-b",
      tabs: [
        { id: "tab-a", threadId: "线程-1" },
        { id: "tab-b", threadId: null },
      ],
    });
  });

  it("绑定服务器时校验响应服务器与版本", async () => {
    const ipc = new FakeIpc();
    ipc.responses.set("bind_window_server", boundState({ version: 8 }));

    await expect(
      bindWindowServer({ expectedVersion: 7, serverId: SERVER_A }, ipc),
    ).resolves.toMatchObject({ version: 8, serverId: SERVER_A });
    expect(ipc.calls[0]).toEqual({
      command: "bind_window_server",
      arguments: {
        request: { expectedVersion: 7, serverId: SERVER_A },
      },
    });

    ipc.responses.set("bind_window_server", boundState({
      version: 9,
      serverId: SERVER_B,
    }));
    await expect(
      bindWindowServer({ expectedVersion: 8, serverId: SERVER_A }, ipc),
    ).rejects.toMatchObject({ code: "invalidResponse" });
  });

  it("更新完整标签集合并校验响应相关性", async () => {
    const ipc = new FakeIpc();
    const tabs = [
      { id: "tab-a", threadId: "thread-a" },
      { id: "tab-b", threadId: null },
    ] as const;
    ipc.responses.set("update_window_tabs", boundState({
      version: 3,
      tabs,
      activeTabId: "tab-b",
      updatedAtMs: 2_000,
    }));

    await updateWindowTabs({
      expectedVersion: 2,
      tabs,
      activeTabId: "tab-b",
    }, ipc);
    expect(ipc.calls[0]).toEqual({
      command: "update_window_tabs",
      arguments: {
        request: {
          expectedVersion: 2,
          tabs,
          activeTabId: "tab-b",
        },
      },
    });

    ipc.responses.set("update_window_tabs", boundState({
      version: 4,
      tabs,
      activeTabId: "tab-a",
    }));
    await expect(updateWindowTabs({
      expectedVersion: 3,
      tabs,
      activeTabId: "tab-b",
    }, ipc)).rejects.toMatchObject({ code: "invalidResponse" });
  });

  it("拒绝重复会话、缺失活动标签和非法请求", async () => {
    const ipc = new FakeIpc();
    const invalidStates = [
      boundState({ activeTabId: "missing" }),
      boundState({
        tabs: [
          { id: "tab-a", threadId: "thread-a" },
          { id: "tab-b", threadId: "thread-a" },
        ],
      }),
      unboundState({ tabs: [{ id: "tab-a", threadId: null }] }),
      unboundState({ activeTabId: "tab-a" }),
    ];
    for (const invalid of invalidStates) {
      ipc.responses.set("load_window_state", invalid);
      await expect(loadWindowState(ipc)).rejects.toBeInstanceOf(
        WindowStateTransportError,
      );
    }

    for (const request of [
      { expectedVersion: 1, tabs: [], activeTabId: "tab-a" },
      {
        expectedVersion: 1,
        tabs: [{ id: "tab-a", threadId: null }],
        activeTabId: "missing",
      },
      {
        expectedVersion: 1,
        tabs: [{ id: "", threadId: null }],
        activeTabId: "",
      },
    ]) {
      await expect(updateWindowTabs(request, ipc)).rejects.toMatchObject({
        code: "invalidRequest",
      });
    }
  });

  it("打开窗口接受新窗口或已有 main 窗口标签", async () => {
    const ipc = new FakeIpc();
    const windowId = "0198a708-8c47-7e56-8458-155a60c8945c";
    ipc.responses.set("open_app_window", {
      windowId,
      label: `app-${windowId}`,
    });
    await expect(
      openAppWindow({ serverId: SERVER_B, threadId: "thread-5" }, ipc),
    ).resolves.toEqual({ windowId, label: `app-${windowId}` });

    ipc.responses.set("open_app_window", {
      windowId: "main",
      label: "main",
    });
    await expect(openAppWindow({ serverId: SERVER_A }, ipc)).resolves.toEqual({
      windowId: "main",
      label: "main",
    });
  });

  it("识别服务器已被其它窗口占用并收敛其它命令错误", async () => {
    const ipc = new FakeIpc();
    ipc.failures.set("bind_window_server", {
      code: "serverAlreadyOpen",
      message: "already open",
    });
    await expect(
      bindWindowServer({ expectedVersion: 1, serverId: SERVER_A }, ipc),
    ).rejects.toMatchObject({ code: "serverAlreadyOpen" });

    ipc.failures.set("load_window_state", {
      code: "unknown",
      message: "DO_NOT_REPORT database path",
    });
    const error = await loadWindowState(ipc).catch((failure: unknown) => failure);
    expect(error).toMatchObject({ code: "commandFailed" });
    expect(JSON.stringify(error)).not.toContain("DO_NOT_REPORT");
  });
});
