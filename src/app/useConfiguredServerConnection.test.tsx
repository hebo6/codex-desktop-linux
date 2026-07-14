import { StrictMode, type PropsWithChildren } from "react";
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AppServerSessionState, AppServerThreadClient } from "../appServer";
import type { ServerId } from "../configuration/model";
import {
  ConfiguredServerConnectionController,
  mapAppServerSessionStateToConnectionView,
  useConfiguredServerConnection,
} from "./useConfiguredServerConnection";
import type {
  ConfiguredServerSessionFactory,
  ConfiguredServerSessionFactoryOptions,
} from "./useConfiguredServerConnection";

const SERVER_A = "11111111-1111-4111-8111-111111111111" as ServerId;
const SERVER_B = "22222222-2222-4222-8222-222222222222" as ServerId;

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (reason: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

class FakeSession {
  readonly startResult = deferred<unknown>();
  readonly threadClient?: AppServerThreadClient;
  startCalls = 0;
  closeCalls = 0;
  closeImplementation: () => Promise<void> = () => Promise.resolve();

  constructor(
    readonly options: ConfiguredServerSessionFactoryOptions,
    threadClient: AppServerThreadClient | undefined,
  ) {
    if (threadClient !== undefined) {
      this.threadClient = threadClient;
    }
  }

  start(): Promise<unknown> {
    this.startCalls += 1;
    return this.startResult.promise;
  }

  close(): Promise<void> {
    this.closeCalls += 1;
    return this.closeImplementation();
  }

  emit(state: AppServerSessionState): void {
    this.options.onStateChange(state);
  }
}

class SessionHarness {
  readonly sessions: FakeSession[] = [];

  constructor(
    private readonly threadClient: AppServerThreadClient | undefined = undefined,
  ) {}

  readonly factory: ConfiguredServerSessionFactory = (options) => {
    const session = new FakeSession(options, this.threadClient);
    this.sessions.push(session);
    return session;
  };
}

function sessionState(
  phase: AppServerSessionState["phase"],
  errorCode: AppServerSessionState["errorCode"] = null,
  connectionStage: AppServerSessionState["connectionStage"] = null,
  transportTermination?: AppServerSessionState["transportTermination"],
): AppServerSessionState {
  return {
    phase,
    connectionStage,
    initializeResponse: null,
    errorCode,
    ...(transportTermination === undefined ? {} : { transportTermination }),
  };
}

function StrictModeWrapper({ children }: PropsWithChildren) {
  return <StrictMode>{children}</StrictMode>;
}

describe("useConfiguredServerConnection", () => {
  it("以现有未连接视图启动并按 serverId 创建、初始化会话", async () => {
    const threadClient = {} as AppServerThreadClient;
    const harness = new SessionHarness(threadClient);
    const { result, unmount } = renderHook(() =>
      useConfiguredServerConnection({
        sessionFactory: harness.factory,
        connectionIdFactory: () => "connection-1",
      }),
    );

    expect(result.current.currentServerId).toBeNull();
    expect(result.current.threadClient).toBeNull();
    expect(result.current.view).toEqual({
      phase: "disconnected",
      detail: null,
    });

    let connection!: Promise<void>;
    act(() => {
      connection = result.current.connect(SERVER_A);
    });

    expect(result.current.currentServerId).toBe(SERVER_A);
    expect(result.current.view).toEqual({ phase: "connecting", detail: null });
    await waitFor(() => expect(harness.sessions).toHaveLength(1));
    const session = harness.sessions[0]!;
    expect(session.options.request).toEqual({
      connectionId: "connection-1",
      serverId: SERVER_A,
    });
    expect(session.startCalls).toBe(1);

    act(() => session.emit(sessionState("connecting", null, "establishingTunnel")));
    expect(result.current.connectionStage).toBe("establishingTunnel");
    expect(result.current.view).toEqual({ phase: "connecting", detail: "建立隧道" });

    act(() => session.emit(sessionState("initializing", null, "appServerInitialization")));
    expect(result.current.connectionStage).toBe("appServerInitialization");
    expect(result.current.view).toEqual({
      phase: "initializing",
      detail: "app-server 初始化",
    });

    act(() => session.emit(sessionState("ready")));
    expect(result.current.threadClient).toBe(threadClient);
    session.startResult.resolve({});
    await act(async () => connection);
    expect(result.current.view).toEqual({ phase: "ready", detail: null });

    unmount();
  });

  it("切换服务器时等待旧会话关闭，并忽略旧会话的迟到状态", async () => {
    const harness = new SessionHarness();
    const ids = ["connection-a", "connection-b"];
    const { result, unmount } = renderHook(() =>
      useConfiguredServerConnection({
        sessionFactory: harness.factory,
        connectionIdFactory: () => ids.shift() ?? "invalid",
      }),
    );

    let firstConnection!: Promise<void>;
    act(() => {
      firstConnection = result.current.connect(SERVER_A);
    });
    await waitFor(() => expect(harness.sessions).toHaveLength(1));
    const firstSession = harness.sessions[0]!;
    const firstClose = deferred<void>();
    firstSession.closeImplementation = () => firstClose.promise;

    let secondConnection!: Promise<void>;
    act(() => {
      secondConnection = result.current.connect(SERVER_B);
    });
    await waitFor(() => expect(firstSession.closeCalls).toBe(1));
    expect(harness.sessions).toHaveLength(1);
    expect(result.current).toMatchObject({
      currentServerId: SERVER_B,
      view: { phase: "connecting", detail: null },
    });

    act(() => firstSession.emit(sessionState("ready")));
    expect(result.current.view.phase).toBe("connecting");

    firstClose.resolve();
    await waitFor(() => expect(harness.sessions).toHaveLength(2));
    const secondSession = harness.sessions[1]!;
    expect(secondSession.options.request).toEqual({
      connectionId: "connection-b",
      serverId: SERVER_B,
    });

    act(() => secondSession.emit(sessionState("initializing")));
    act(() => firstSession.emit(sessionState("error", "transportFailure")));
    expect(result.current.view.phase).toBe("initializing");

    firstSession.startResult.resolve({});
    secondSession.startResult.resolve({});
    await act(async () => Promise.all([firstConnection, secondConnection]));
    unmount();
  });

  it("重试复用当前目标、关闭失败会话并分配新的连接标识", async () => {
    const harness = new SessionHarness();
    const ids = ["INVALID", "connection-1", "connection-1", "connection-2"];
    const { result, unmount } = renderHook(() =>
      useConfiguredServerConnection({
        sessionFactory: harness.factory,
        connectionIdFactory: () => ids.shift() ?? "invalid",
      }),
    );

    let firstConnection!: Promise<void>;
    act(() => {
      firstConnection = result.current.connect(SERVER_A);
    });
    await waitFor(() => expect(harness.sessions).toHaveLength(1));
    const failedSession = harness.sessions[0]!;
    act(() =>
      failedSession.emit(sessionState("error", "transportConnectFailed")),
    );
    failedSession.startResult.reject({
      code: "transportConnectFailed",
      message: "sensitive endpoint must not be displayed",
    });
    await act(async () => firstConnection);
    expect(result.current.view).toEqual({
      phase: "error",
      detail: "无法建立服务器连接",
    });

    let retry!: Promise<void>;
    act(() => {
      retry = result.current.retry();
    });
    await waitFor(() => expect(harness.sessions).toHaveLength(2));
    const retriedSession = harness.sessions[1]!;
    expect(failedSession.closeCalls).toBe(1);
    expect(retriedSession.options.request).toEqual({
      connectionId: "connection-2",
      serverId: SERVER_A,
    });

    act(() => retriedSession.emit(sessionState("ready")));
    retriedSession.startResult.resolve({});
    await act(async () => retry);
    expect(result.current.view.phase).toBe("ready");
    unmount();
  });

  it("断开并发启动中的会话后保留当前服务器，且旧状态不能复活连接", async () => {
    const harness = new SessionHarness();
    const { result, unmount } = renderHook(() =>
      useConfiguredServerConnection({
        sessionFactory: harness.factory,
        connectionIdFactory: () => "connection-1",
      }),
    );

    let connection!: Promise<void>;
    act(() => {
      connection = result.current.connect(SERVER_A);
    });
    await waitFor(() => expect(harness.sessions).toHaveLength(1));
    const session = harness.sessions[0]!;

    let disconnection!: Promise<void>;
    act(() => {
      disconnection = result.current.disconnect();
    });
    expect(result.current).toMatchObject({
      currentServerId: SERVER_A,
      view: { phase: "disconnected", detail: null },
    });
    await act(async () => disconnection);
    expect(session.closeCalls).toBe(1);

    act(() => session.emit(sessionState("ready")));
    expect(result.current.view.phase).toBe("disconnected");
    session.startResult.resolve({});
    await act(async () => connection);
    unmount();
  });

  it("旧会话关闭失败时不创建新会话，且错误摘要不泄漏底层信息", async () => {
    const harness = new SessionHarness();
    const controller = new ConfiguredServerConnectionController({
      sessionFactory: harness.factory,
      connectionIdFactory: () => "connection-1",
    });

    const firstConnection = controller.connect(SERVER_A);
    await waitFor(() => expect(harness.sessions).toHaveLength(1));
    const session = harness.sessions[0]!;
    session.closeImplementation = () =>
      Promise.reject(new Error("secret close failure detail"));

    await controller.connect(SERVER_B);
    expect(harness.sessions).toHaveLength(1);
    expect(controller.getSnapshot()).toEqual({
      capabilityClient: null,
      connectionStage: null,
      conversationClient: null,
      fileClient: null,
      interactionClient: null,
      accountClient: null,
      reconnect: null,
      currentServerId: SERVER_B,
      threadClient: null,
      view: { phase: "error", detail: "无法关闭上一连接" },
    });

    session.startResult.resolve({});
    await firstConnection;
    await controller.dispose();
  });

  it("React 严格模式卸载只关闭当前会话一次", async () => {
    const harness = new SessionHarness();
    const { result, unmount } = renderHook(
      () =>
        useConfiguredServerConnection({
          sessionFactory: harness.factory,
          connectionIdFactory: () => "connection-1",
        }),
      { wrapper: StrictModeWrapper },
    );

    act(() => {
      void result.current.connect(SERVER_A);
    });
    await waitFor(() => expect(harness.sessions).toHaveLength(1));
    const session = harness.sessions[0]!;

    unmount();
    await waitFor(() => expect(session.closeCalls).toBe(1));
    act(() => session.emit(sessionState("ready")));
    expect(session.closeCalls).toBe(1);
  });
});

describe("ConfiguredServerConnectionController 自动重连", () => {
  afterEach(() => vi.useRealTimers());

  it("连接曾就绪后按退避序列自动重连并可停止", async () => {
    vi.useFakeTimers();
    let now = 10_000;
    let connectionSequence = 0;
    const harness = new SessionHarness();
    const controller = new ConfiguredServerConnectionController({
      sessionFactory: harness.factory,
      connectionIdFactory: () => `connection-${++connectionSequence}`,
      now: () => now,
      random: () => 0.5,
    });

    const firstConnection = controller.connect(SERVER_A);
    await vi.waitFor(() => expect(harness.sessions).toHaveLength(1));
    const firstSession = harness.sessions[0]!;
    firstSession.emit(sessionState("ready"));
    firstSession.startResult.resolve({});
    await firstConnection;

    firstSession.emit(sessionState("error", "transportClosed"));
    expect(controller.getSnapshot().reconnect).toEqual({ attempt: 1, nextAttemptAt: 11_000 });
    await vi.advanceTimersByTimeAsync(999);
    expect(harness.sessions).toHaveLength(1);
    now += 1_000;
    await vi.advanceTimersByTimeAsync(1);
    await vi.waitFor(() => expect(harness.sessions).toHaveLength(2));

    const secondSession = harness.sessions[1]!;
    secondSession.emit(sessionState("error", "transportConnectFailed"));
    secondSession.startResult.resolve({});
    expect(controller.getSnapshot().reconnect).toEqual({ attempt: 2, nextAttemptAt: 13_000 });

    controller.stopReconnect();
    expect(controller.getSnapshot().reconnect).toBeNull();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(harness.sessions).toHaveLength(2);
    await controller.dispose();
  });

  it("从未就绪的配置或初始化错误不会无限自动重试", async () => {
    const harness = new SessionHarness();
    const controller = new ConfiguredServerConnectionController({
      sessionFactory: harness.factory,
      connectionIdFactory: () => "connection-1",
    });
    const connection = controller.connect(SERVER_A);
    await waitFor(() => expect(harness.sessions).toHaveLength(1));
    const session = harness.sessions[0]!;
    session.emit(sessionState("error", "initializationRejected"));
    session.startResult.resolve({});
    await connection;

    expect(controller.getSnapshot().reconnect).toBeNull();
    expect(controller.getSnapshot().view.detail).toBe("app-server 拒绝初始化");
    await controller.dispose();
  });

  it("连续三次短时退出后停止本机进程自动重启", async () => {
    vi.useFakeTimers();
    let now = 20_000;
    let connectionSequence = 0;
    const harness = new SessionHarness();
    const controller = new ConfiguredServerConnectionController({
      sessionFactory: harness.factory,
      connectionIdFactory: () => `local-${++connectionSequence}`,
      now: () => now,
      random: () => 0.5,
    });
    const termination = {
      kind: "localProcess",
      status: "exited",
      reason: "processExited",
      exitCode: 7,
      stderrBytes: 96,
      forced: false,
    } as const;

    const firstConnection = controller.connect(SERVER_A);
    await vi.waitFor(() => expect(harness.sessions).toHaveLength(1));
    for (let exitCount = 1; exitCount <= 3; exitCount += 1) {
      const session = harness.sessions[exitCount - 1]!;
      session.emit(sessionState("ready"));
      session.startResult.resolve({});
      if (exitCount === 1) await firstConnection;
      now += 100;
      session.emit(sessionState("error", "transportClosed", null, termination));

      if (exitCount < 3) {
        expect(controller.getSnapshot().view.detail).toBe(
          "本机进程已退出（退出码 7；标准错误输出 96 字节（内容已脱敏隐藏））",
        );
        const nextAttemptAt = controller.getSnapshot().reconnect?.nextAttemptAt;
        expect(nextAttemptAt).not.toBeNull();
        const delay = nextAttemptAt! - now;
        now = nextAttemptAt!;
        await vi.advanceTimersByTimeAsync(delay);
        await vi.waitFor(() => expect(harness.sessions).toHaveLength(exitCount + 1));
      }
    }

    expect(controller.getSnapshot().reconnect).toBeNull();
    expect(controller.getSnapshot().view.detail).toBe(
      "本机进程连续 3 次短时间退出，请检查服务器配置后手动重新启动",
    );
    await vi.advanceTimersByTimeAsync(30_000);
    expect(harness.sessions).toHaveLength(3);
    await controller.dispose();
  });
});

describe("mapAppServerSessionStateToConnectionView", () => {
  it("将关闭阶段归一为未连接，并提供固定的初始化错误摘要", () => {
    expect(
      mapAppServerSessionStateToConnectionView(sessionState("closing")),
    ).toEqual({ phase: "disconnected", detail: null });
    expect(
      mapAppServerSessionStateToConnectionView(
        sessionState("error", "initializationRejected"),
      ),
    ).toEqual({ phase: "error", detail: "app-server 拒绝初始化" });
  });
});
