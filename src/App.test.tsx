import { configureStore } from "@reduxjs/toolkit";
import { Provider } from "react-redux";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type {
  ConfiguredServerSessionFactory,
  ConfiguredServerSessionFactoryOptions,
} from "./app/useConfiguredServerConnection";
import type { ServerConnectionTestControllerOptions } from "./app/useServerConnectionTest";
import type { ServerProfileMutationCommands } from "./app/useServerProfileMutations";
import type { WindowStateControllerOptions } from "./app/useWindowState";
import {
  AppServerConversationClient,
  AppServerThreadClient,
  type ServerConnectionTestProbe,
} from "./appServer";
import {
  App,
  collectHighRiskServerIds,
  recentWorkingDirectories,
  type AppWindowOpener,
  type CredentialStorageStatusLoader,
} from "./App";
import {
  ConfigurationCommandError,
  type ConfigurationSnapshot,
  type ProxyId,
  type ProxyProfile,
  type RemoteWebSocketServerConfiguration,
  type ServerId,
  type ServerProfile,
} from "./configuration";
import {
  configurationReducer,
  configurationSnapshotReplaced,
} from "./store/configurationSlice";
import { connectionReducer } from "./store/connectionSlice";
import type { ServerNotification } from "./protocol/generated";
import type {
  UpdateWindowSessionRequest,
  WindowServerReferenceSubscriber,
  WindowState,
} from "./transport/windowState";
import type { DeepLinkTargetSubscriber } from "./transport/deepLink";
import type { ConfiguredServerStatusSubscriber } from "./transport/configuredServerStatuses";
import type { DraftStore } from "./transport/drafts";

const SERVER_ID = "11111111-1111-4111-8111-111111111111" as ServerId;
const SECOND_SERVER_ID = "33333333-3333-4333-8333-333333333333" as ServerId;
const PROXY_ID = "22222222-2222-4222-8222-222222222222" as ProxyId;

function localServer(
  serverId: ServerId = SERVER_ID,
  name = "本机开发",
): ServerProfile {
  return {
    serverId,
    name,
    version: 1,
    configuration: {
      type: "localStdio",
      executablePath: "/usr/bin/codex",
      arguments: ["app-server"],
      nonSensitiveEnvironment: {},
    },
    credentialConfigured: false,
    activeWindowCount: 0,
    createdAtMs: 1,
    updatedAtMs: 1,
  };
}

function remoteServer(
  version: number,
  credentialConfigured: boolean,
): ServerProfile {
  return {
    serverId: SERVER_ID,
    name: "远程开发",
    version,
    configuration: {
      type: "remoteWebSocket",
      url: "wss://codex.example.test/app-server",
      authentication: "bearer",
      nonSensitiveHeaders: {},
      connectTimeoutMs: 30_000,
      tlsCertificatePolicy: "strict",
      plaintextConfirmed: false,
    },
    credentialConfigured,
    activeWindowCount: 0,
    createdAtMs: 1,
    updatedAtMs: version,
  };
}

function withRemoteConfiguration(
  server: ServerProfile,
  changes: Partial<RemoteWebSocketServerConfiguration>,
): ServerProfile {
  if (server.configuration.type !== "remoteWebSocket") {
    throw new TypeError("expected a remote server");
  }
  return {
    ...server,
    configuration: { ...server.configuration, ...changes },
  };
}

function httpProxy(
  tlsCertificatePolicy: "strict" | "allowInvalidCertificate",
): ProxyProfile {
  return {
    proxyId: PROXY_ID,
    name: "开发代理",
    version: 1,
    configuration: {
      type: "httpConnect",
      url: "https://proxy.example.test",
      authentication: "none",
      nonSensitiveHeaders: {},
      connectTimeoutMs: 10_000,
      tlsCertificatePolicy,
    },
    credentialConfigured: false,
    referencedServerCount: 1,
    createdAtMs: 1,
    updatedAtMs: 1,
  };
}

function createTestStore() {
  return configureStore({
    reducer: {
      configuration: configurationReducer,
      connection: connectionReducer,
    },
  });
}

function renderApp(
  snapshot: () => ConfigurationSnapshot | Promise<ConfigurationSnapshot>,
  options: {
    readonly sessionFactory?: ConfiguredServerSessionFactory;
    readonly credentialStorageStatusLoader?: CredentialStorageStatusLoader;
    readonly connectionTestOptions?: ServerConnectionTestControllerOptions;
    readonly mutationCommands?: Partial<ServerProfileMutationCommands>;
    readonly windowStateOptions?: WindowStateControllerOptions;
    readonly windowOpener?: AppWindowOpener;
    readonly windowReferenceSubscriber?: WindowServerReferenceSubscriber;
    readonly deepLinkSubscriber?: DeepLinkTargetSubscriber;
    readonly configuredServerStatusSubscriber?: ConfiguredServerStatusSubscriber;
    readonly draftStore?: DraftStore;
  } = {},
) {
  const testStore = createTestStore();
  const loader = vi.fn(async () => snapshot());
  const connectionIds = ["connection-1", "connection-2"];
  let authoritativeWindowState: WindowState = {
    windowId: "main",
    version: 1,
    updatedAtMs: 1,
  };
  const windowStateOptions: WindowStateControllerOptions =
    options.windowStateOptions ?? {
      loader: vi.fn(async () => authoritativeWindowState),
      binder: vi.fn(async ({ serverId }) => {
        if ((authoritativeWindowState.serverId ?? null) === serverId) {
          return authoritativeWindowState;
        }
        authoritativeWindowState = {
          windowId: authoritativeWindowState.windowId,
          version: authoritativeWindowState.version + 1,
          updatedAtMs: authoritativeWindowState.updatedAtMs + 1,
          ...(serverId === null ? {} : { serverId }),
        };
        return authoritativeWindowState;
      }),
    };
  const windowOpener =
    options.windowOpener ??
    vi.fn(async () => ({
      windowId: "33333333-3333-4333-8333-333333333333",
      label: "app-33333333-3333-4333-8333-333333333333",
    }));
  const view = render(
    <Provider store={testStore}>
      <App
        configurationLoader={loader}
        credentialStorageStatusLoader={
          options.credentialStorageStatusLoader ??
          (async () => ({ backend: "secretService" }))
        }
        connectionOptions={{
          connectionIdFactory: () => connectionIds.shift() ?? "connection-next",
          ...(options.sessionFactory === undefined
            ? {}
            : { sessionFactory: options.sessionFactory }),
        }}
        {...(options.connectionTestOptions === undefined
          ? {}
          : { connectionTestOptions: options.connectionTestOptions })}
        {...(options.mutationCommands === undefined
          ? {}
          : { mutationCommands: options.mutationCommands })}
        windowOpener={windowOpener}
        windowReferenceSubscriber={
          options.windowReferenceSubscriber ??
          (async () => () => undefined)
        }
        deepLinkSubscriber={
          options.deepLinkSubscriber ?? (async () => () => undefined)
        }
        configuredServerStatusSubscriber={
          options.configuredServerStatusSubscriber ??
          (async () => () => undefined)
        }
        {...(options.draftStore === undefined
          ? {}
          : { draftStore: options.draftStore })}
        windowStateOptions={windowStateOptions}
      />
    </Provider>,
  );
  return { loader, testStore, windowOpener, unmount: view.unmount };
}

describe("App", () => {
  it("通过 Ctrl+/ 打开并关闭键盘快捷键列表", async () => {
    renderApp(() => ({ servers: [], proxies: [] }));

    await screen.findByRole("button", {
      name: "选择服务器，未连接，打开服务器选择器",
    });
    fireEvent.keyDown(window, { ctrlKey: true, key: "/" });
    expect(screen.getByRole("dialog", { name: "键盘快捷键" })).toBeVisible();

    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "键盘快捷键" })).not.toBeInTheDocument();
  });

  it("密钥环不可用时在创建凭据前要求确认明文存储", async () => {
    const user = userEvent.setup();
    let authoritativeSnapshot: ConfigurationSnapshot = {
      servers: [],
      proxies: [],
    };
    const createServerProfile = vi.fn(async () => {
      const profile = remoteServer(1, false);
      authoritativeSnapshot = { servers: [profile], proxies: [] };
      return profile;
    });
    const setServerCredential = vi.fn(async () => {
      const profile = remoteServer(2, true);
      authoritativeSnapshot = { servers: [profile], proxies: [] };
      return profile;
    });
    renderApp(() => authoritativeSnapshot, {
      credentialStorageStatusLoader: async () => ({ backend: "plaintextFile" }),
      mutationCommands: { createServerProfile, setServerCredential },
    });

    await user.click(
      await screen.findByRole("button", {
        name: "选择服务器，未连接，打开服务器选择器",
      }),
    );
    await user.click(screen.getByRole("button", { name: "新建第一个服务器" }));
    await user.type(screen.getByLabelText(/^名称/u), "远程开发");
    await user.click(screen.getByRole("radio", { name: /远程 WebSocket/u }));
    await user.type(
      screen.getByLabelText(/^WebSocket URL/u),
      "wss://codex.example.test/app-server",
    );
    await user.selectOptions(screen.getByLabelText(/^认证方式/u), "bearer");
    await user.type(screen.getByLabelText(/^Bearer 令牌/u), "plain-secret");
    await user.click(screen.getByRole("button", { name: "保存" }));

    expect(
      await screen.findByRole("alertdialog", {
        name: "使用明文文件保存凭据？",
      }),
    ).toBeVisible();
    expect(createServerProfile).not.toHaveBeenCalled();
    expect(setServerCredential).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "返回编辑" }));
    expect(screen.getByLabelText(/^Bearer 令牌/u)).toHaveValue("plain-secret");
    await user.click(screen.getByRole("button", { name: "保存" }));
    await user.click(
      await screen.findByRole("button", { name: "确认使用明文文件" }),
    );

    await waitFor(() => expect(setServerCredential).toHaveBeenCalledTimes(1));
    expect(createServerProfile).toHaveBeenCalledTimes(1);
    expect(setServerCredential).toHaveBeenCalledWith(
      expect.objectContaining({ plaintextFallbackConfirmed: true }),
    );
  });

  it("按会话新旧顺序提取去重后的最近工作目录", () => {
    expect(recentWorkingDirectories([
      { cwd: "/workspace/alpha" },
      { cwd: "/workspace/beta" },
      { cwd: " /workspace/alpha " },
      { cwd: "" },
    ])).toEqual(["/workspace/alpha", "/workspace/beta"]);
  });

  it("顶部新建继承当前目录并支持从项目组新建", async () => {
    const user = userEvent.setup();
    const thread = {
      cliVersion: "1.0.0",
      createdAt: 100,
      cwd: "/workspace/current",
      ephemeral: false,
      id: "thread-current",
      modelProvider: "openai",
      name: "当前会话",
      preview: "继续当前任务",
      sessionId: "session-current",
      source: "appServer",
      status: { type: "idle" },
      turns: [],
      updatedAt: 200,
    } as const;
    const otherThread = {
      ...thread,
      cwd: "/workspace/other",
      id: "thread-other",
      name: "其他项目会话",
      sessionId: "session-other",
      updatedAt: 100,
    } as const;
    const requestSession = {
      sendRequest(request: { readonly method: string }) {
        const result = request.method === "thread/list"
          ? { data: [thread, otherThread], nextCursor: null }
          : request.method === "thread/resume"
            ? { thread }
            : {};
        return {
          cancel: () => undefined,
          id: `request:${request.method}`,
          result: Promise.resolve(result),
        };
      },
      subscribeNotifications: () => () => undefined,
    };
    const sessionUpdater = vi.fn(async (request: UpdateWindowSessionRequest) => ({
      windowId: "main",
      version: request.expectedVersion + 1,
      serverId: SERVER_ID,
      ...(request.currentThreadId === null
        ? {}
        : { currentThreadId: request.currentThreadId }),
      ...(request.draftKey === null ? {} : { draftKey: request.draftKey }),
      updatedAtMs: 2,
    }));
    const sessionFactory: ConfiguredServerSessionFactory = (options) => ({
      threadClient: new AppServerThreadClient(requestSession as never),
      async start() {
        options.onStateChange({
          phase: "ready",
          connectionStage: null,
          initializeResponse: null,
          errorCode: null,
        });
      },
      async close() {},
    });
    const draftStore: DraftStore = {
      listKeys: vi.fn(async (keyPrefix) => [`${keyPrefix}${thread.id}`]),
      load: vi.fn(async (draftKey) => draftKey.endsWith(thread.id)
        ? { text: "未发送草稿", tokens: [] }
        : null),
      save: vi.fn(async () => undefined),
      delete: vi.fn(async () => undefined),
    };

    renderApp(() => ({ servers: [localServer()], proxies: [] }), {
      draftStore,
      sessionFactory,
      windowStateOptions: {
        loader: vi.fn(async () => ({
          windowId: "main",
          version: 1,
          serverId: SERVER_ID,
          currentThreadId: thread.id,
          updatedAtMs: 1,
        })),
        sessionUpdater,
      },
    });

    await screen.findByText("这个会话还没有回合");
    expect(screen.getByRole("img", { name: "存在未发送草稿" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "项目" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "最近会话操作" }));
    await user.click(screen.getByRole("menuitem", { name: /搜索会话/u }));
    expect(screen.getByRole("dialog", { name: "快速切换会话" })).toBeVisible();
    await user.keyboard("{Escape}");
    await user.click(screen.getByRole("button", { name: "新建任务" }));

    await waitFor(() => expect(sessionUpdater).toHaveBeenCalledWith({
      expectedVersion: 1,
      currentThreadId: null,
      draftKey: expect.stringMatching(/^draft:/u),
    }));
    await waitFor(() => {
      const newTaskCwd = screen.getByRole("button", { name: "项目" });
      expect(newTaskCwd).toBeEnabled();
      expect(newTaskCwd).toHaveAttribute("title", thread.cwd);
    });

    await user.click(screen.getByRole("button", { name: "按项目分组" }));
    await user.click(screen.getByRole("button", {
      name: `在 ${otherThread.cwd} 中新建会话`,
    }));

    await waitFor(() => expect(sessionUpdater).toHaveBeenLastCalledWith({
      expectedVersion: 2,
      currentThreadId: null,
      draftKey: expect.stringMatching(/^draft:/u),
    }));
    await waitFor(() => expect(
      screen.getByRole("button", { name: "项目" }),
    ).toHaveAttribute("title", otherThread.cwd));
  });

  it("新建线程首次发送直接采用创建响应", async () => {
    const user = userEvent.setup();
    const startedThread = {
      cliVersion: "1.0.0",
      createdAt: 100,
      cwd: "/workspace/new",
      ephemeral: false,
      id: "thread-new",
      modelProvider: "openai",
      preview: "新任务",
      sessionId: "session-new",
      source: "appServer",
      status: { type: "idle" },
      turns: [],
      updatedAt: 200,
    } as const;
    const requestMethods: string[] = [];
    const notificationHandlers = new Set<
      (notification: ServerNotification) => void
    >();
    const requestSession = {
      sendRequest(request: { readonly method: string }) {
        requestMethods.push(request.method);
        const result =
          request.method === "thread/list"
            ? { data: [], nextCursor: null }
            : request.method === "thread/start"
              ? {
                  approvalPolicy: "on-request",
                  approvalsReviewer: "user",
                  cwd: startedThread.cwd,
                  model: "gpt-5",
                  modelProvider: "openai",
                  sandbox: { type: "readOnly" },
                  thread: startedThread,
                }
              : request.method === "turn/start"
                ? {
                    turn: {
                      id: "turn-new",
                      items: [{
                        id: "user-new",
                        type: "userMessage",
                        content: [{ type: "text", text: "首次问题" }],
                      }],
                      status: "inProgress",
                    },
                  }
                : request.method === "thread/unsubscribe"
                  ? { status: "unsubscribed" }
                  : {};
        return {
          cancel: () => undefined,
          id: `request:${request.method}`,
          result: Promise.resolve(result),
        };
      },
      subscribeNotifications(handler: (notification: ServerNotification) => void) {
        notificationHandlers.add(handler);
        return () => notificationHandlers.delete(handler);
      },
    };
    const sessionUpdater = vi.fn(async (request: UpdateWindowSessionRequest) => ({
      windowId: "main",
      version: 2,
      serverId: SERVER_ID,
      ...(request.currentThreadId === null
        ? {}
        : { currentThreadId: request.currentThreadId }),
      ...(request.draftKey === null ? {} : { draftKey: request.draftKey }),
      updatedAtMs: 2,
    }));
    const sessionFactory: ConfiguredServerSessionFactory = (options) => ({
      threadClient: new AppServerThreadClient(requestSession as never),
      conversationClient: new AppServerConversationClient(requestSession as never),
      async start() {
        options.onStateChange({
          phase: "ready",
          connectionStage: null,
          initializeResponse: null,
          errorCode: null,
        });
      },
      async close() {},
    });

    renderApp(() => ({ servers: [localServer()], proxies: [] }), {
      sessionFactory,
      windowStateOptions: {
        loader: vi.fn(async () => ({
          windowId: "main",
          version: 1,
          serverId: SERVER_ID,
          updatedAtMs: 1,
        })),
        sessionUpdater,
      },
    });

    await user.type(
      await screen.findByRole("textbox", { name: "任务输入" }),
      "首次问题",
    );
    await user.click(screen.getByRole("button", { name: "发送" }));

    await waitFor(() => expect(requestMethods).toContain("turn/start"));
    expect(requestMethods).not.toContain("thread/resume");
    expect(sessionUpdater).toHaveBeenCalledWith({
      expectedVersion: 1,
      currentThreadId: startedThread.id,
      draftKey: null,
    });
    await waitFor(() => expect(screen.getByText("首次问题")).toBeVisible());
    expect(screen.queryByRole("button", { name: "项目" })).not.toBeInTheDocument();
    expect(screen.queryByText("这个会话还没有回合")).not.toBeInTheDocument();
    expect(screen.queryByRole("alert", { name: /无法恢复会话/u })).not.toBeInTheDocument();

    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(requestMethods).toContain("turn/interrupt"));

    act(() => {
      const completed = {
        method: "turn/completed",
        params: {
          threadId: startedThread.id,
          turn: {
            id: "turn-new",
            items: [],
            itemsView: "notLoaded",
            status: "completed",
            durationMs: 3_500,
          },
        },
      } as ServerNotification;
      for (const handler of notificationHandlers) handler(completed);
    });

    await waitFor(() => expect(screen.getByRole("button", { name: "发送" })).toBeVisible());
    expect(screen.getByText("首次问题")).toBeVisible();
  });

  it("没有已打开会话时默认选择最近项目", async () => {
    const recentThread = {
      cliVersion: "1.0.0",
      createdAt: 200,
      cwd: "/workspace/recent",
      ephemeral: false,
      id: "thread-recent",
      modelProvider: "openai",
      name: "最近会话",
      preview: "继续最近任务",
      sessionId: "session-recent",
      source: "appServer",
      status: { type: "idle" },
      turns: [],
      updatedAt: 300,
    } as const;
    const olderThread = {
      ...recentThread,
      cwd: "/workspace/older",
      id: "thread-older",
      name: "较早会话",
      sessionId: "session-older",
      updatedAt: 100,
    } as const;
    const requestSession = {
      sendRequest(request: { readonly method: string }) {
        return {
          cancel: () => undefined,
          id: `request:${request.method}`,
          result: Promise.resolve(
            request.method === "thread/list"
              ? { data: [recentThread, olderThread], nextCursor: null }
              : {},
          ),
        };
      },
      subscribeNotifications: () => () => undefined,
    };
    const sessionFactory: ConfiguredServerSessionFactory = (options) => ({
      threadClient: new AppServerThreadClient(requestSession as never),
      async start() {
        options.onStateChange({
          phase: "ready",
          connectionStage: null,
          initializeResponse: null,
          errorCode: null,
        });
      },
      async close() {},
    });
    const server = localServer();
    if (server.configuration.type !== "localStdio") {
      throw new TypeError("expected local server");
    }
    const configuredServer = {
      ...server,
      configuration: {
        ...server.configuration,
        defaultWorkingDirectory: "/workspace/configured",
      },
    };

    renderApp(() => ({ servers: [configuredServer], proxies: [] }), {
      sessionFactory,
      windowStateOptions: {
        loader: vi.fn(async () => ({
          windowId: "main",
          version: 1,
          serverId: SERVER_ID,
          updatedAtMs: 1,
        })),
      },
    });

    const projectPicker = await screen.findByRole("button", { name: "项目" });
    await waitFor(() => expect(projectPicker).toHaveAttribute("title", recentThread.cwd));
    expect(projectPicker).toHaveTextContent("recent");
  });

  it("在服务器选择器展示其他窗口共享物理连接的权威状态", async () => {
    let publishStatuses: Parameters<ConfiguredServerStatusSubscriber>[0] | null = null;
    const configuredServerStatusSubscriber: ConfiguredServerStatusSubscriber = async (
      onChange,
    ) => {
      publishStatuses = onChange;
      return () => undefined;
    };
    renderApp(
      () => ({
        servers: [localServer(), localServer(SECOND_SERVER_ID, "备用服务器")],
        proxies: [],
      }),
      {
        configuredServerStatusSubscriber,
        windowStateOptions: {
          loader: vi.fn(async () => ({
            windowId: "main",
            version: 1,
            serverId: SERVER_ID,
            updatedAtMs: 1,
          })),
        },
      },
    );

    await waitFor(() => expect(publishStatuses).toBeTypeOf("function"));
    act(() => publishStatuses?.([{ serverId: SECOND_SERVER_ID, phase: "ready" }]));
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: /打开服务器选择器/u }));
    expect(screen.getByRole("button", { name: "切换 备用服务器" })).toBeEnabled();
  });

  it("从严格深链目标绑定已保存服务器并打开指定会话", async () => {
    const binder = vi.fn(async () => ({
      windowId: "main",
      version: 2,
      serverId: SERVER_ID,
      updatedAtMs: 2,
    }));
    const sessionUpdater = vi.fn(async () => ({
      windowId: "main",
      version: 3,
      serverId: SERVER_ID,
      currentThreadId: "thread-7",
      updatedAtMs: 3,
    }));
    const deepLinkSubscriber: DeepLinkTargetSubscriber = async (onTarget) => {
      onTarget({ serverId: SERVER_ID, threadId: "thread-7" });
      return () => undefined;
    };
    renderApp(
      () => ({ servers: [localServer()], proxies: [] }),
      {
        deepLinkSubscriber,
        windowStateOptions: {
          loader: vi.fn(async () => ({
            windowId: "main",
            version: 1,
            updatedAtMs: 1,
          })),
          binder,
          sessionUpdater,
        },
      },
    );

    await waitFor(() => expect(binder).toHaveBeenCalledWith({
      expectedVersion: 1,
      serverId: SERVER_ID,
    }));
    await waitFor(() => expect(sessionUpdater).toHaveBeenCalledWith({
      expectedVersion: 2,
      currentThreadId: "thread-7",
      draftKey: null,
    }));
  });

  it("窗口状态激活完成后才读取包含活动引用数的配置快照", async () => {
    let finishWindowLoad: ((state: WindowState) => void) | undefined;
    const windowLoader = vi.fn(
      () =>
        new Promise<WindowState>((resolve) => {
          finishWindowLoad = resolve;
        }),
    );
    const { loader } = renderApp(
      () => ({ servers: [localServer()], proxies: [] }),
      { windowStateOptions: { loader: windowLoader } },
    );

    expect(windowLoader).toHaveBeenCalledTimes(1);
    expect(loader).not.toHaveBeenCalled();
    await act(async () => {
      finishWindowLoad?.({ windowId: "main", version: 1, updatedAtMs: 1 });
    });
    await waitFor(() => expect(loader).toHaveBeenCalledTimes(1));
  });

  it("先恢复持久窗口绑定，再自动连接对应服务器", async () => {
    const sessions: ConfiguredServerSessionFactoryOptions[] = [];
    const sessionFactory: ConfiguredServerSessionFactory = (options) => {
      sessions.push(options);
      return {
        async start() {
          options.onStateChange({
            phase: "ready",
            connectionStage: null,
            initializeResponse: null,
            errorCode: null,
          });
          return {};
        },
        async close() {},
      };
    };

    renderApp(() => ({ servers: [localServer()], proxies: [] }), {
      sessionFactory,
      windowStateOptions: {
        loader: vi.fn(async () => ({
          windowId: "main",
          version: 3,
          serverId: SERVER_ID,
          updatedAtMs: 3,
        })),
      },
    });

    await waitFor(() => expect(sessions).toHaveLength(1));
    expect(sessions[0]?.request).toEqual({
      connectionId: "connection-1",
      serverId: SERVER_ID,
    });
    expect(
      await screen.findByRole("button", {
        name: "本机开发，已连接，打开服务器选择器",
      }),
    ).toBeVisible();
  });

  it("切换服务器时等待窗口绑定落盘后再连接", async () => {
    const user = userEvent.setup();
    let finishBinding: ((state: WindowState) => void) | undefined;
    const binder = vi.fn(
      () =>
        new Promise<WindowState>((resolve) => {
          finishBinding = resolve;
        }),
    );
    const sessions: ConfiguredServerSessionFactoryOptions[] = [];
    const sessionFactory: ConfiguredServerSessionFactory = (options) => {
      sessions.push(options);
      return { async start() {}, async close() {} };
    };
    const { loader } = renderApp(
      () => ({ servers: [localServer()], proxies: [] }),
      {
        sessionFactory,
        windowStateOptions: {
          loader: vi.fn(async () => ({
            windowId: "main",
            version: 1,
            updatedAtMs: 1,
          })),
          binder,
        },
      },
    );

    await user.click(
      await screen.findByRole("button", {
        name: "选择服务器，未连接，打开服务器选择器",
      }),
    );
    await user.click(screen.getByRole("button", { name: "连接 本机开发" }));
    expect(binder).toHaveBeenCalledWith({
      expectedVersion: 1,
      serverId: SERVER_ID,
    });
    expect(sessions).toHaveLength(0);

    await act(async () => {
      finishBinding?.({
        windowId: "main",
        version: 2,
        serverId: SERVER_ID,
        updatedAtMs: 2,
      });
    });

    await waitFor(() => expect(loader).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(sessions).toHaveLength(1));
  });

  it("从服务器行创建后端预绑定的新窗口并刷新权威计数", async () => {
    const user = userEvent.setup();
    const windowOpener = vi.fn(async () => ({
      windowId: "33333333-3333-4333-8333-333333333333",
      label: "app-33333333-3333-4333-8333-333333333333",
    }));
    const { loader } = renderApp(
      () => ({ servers: [localServer()], proxies: [] }),
      { windowOpener },
    );

    await user.click(
      await screen.findByRole("button", {
        name: "选择服务器，未连接，打开服务器选择器",
      }),
    );
    await user.click(
      screen.getByRole("button", { name: "在新窗口打开 本机开发" }),
    );

    expect(windowOpener).toHaveBeenCalledWith({ serverId: SERVER_ID });
    await waitFor(() => expect(loader).toHaveBeenCalledTimes(2));
  });

  it("收到其他窗口引用变化后重新读取活动窗口数并在卸载时退订", async () => {
    let publishReferenceChange: (() => void) | undefined;
    const unlisten = vi.fn();
    const subscriber = vi.fn(async (onChange: () => void) => {
      publishReferenceChange = onChange;
      return unlisten;
    });
    const { loader, unmount } = renderApp(
      () => ({ servers: [localServer()], proxies: [] }),
      { windowReferenceSubscriber: subscriber },
    );
    await waitFor(() => expect(loader).toHaveBeenCalledTimes(1));
    expect(subscriber).toHaveBeenCalledTimes(1);

    act(() => publishReferenceChange?.());
    await waitFor(() => expect(loader).toHaveBeenCalledTimes(2));
    unmount();
    expect(unlisten).toHaveBeenCalledTimes(1);
  });

  it("窗口引用监听失败时展示非阻塞警告并允许重新订阅", async () => {
    const user = userEvent.setup();
    const unlisten = vi.fn();
    const subscriber = vi
      .fn<WindowServerReferenceSubscriber>()
      .mockRejectedValueOnce(new Error("private listener failure"))
      .mockResolvedValueOnce(unlisten);
    renderApp(() => ({ servers: [], proxies: [] }), {
      windowReferenceSubscriber: subscriber,
    });

    await user.click(
      await screen.findByRole("button", { name: /打开服务器选择器/u }),
    );
    expect(screen.getByRole("alert")).toHaveTextContent(
      "无法同步其他窗口状态，请重试",
    );
    expect(screen.queryByText("private listener failure")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "新建服务器" })).toBeEnabled();
    expect(screen.queryByText("未能完成连接")).not.toBeInTheDocument();
    await user.click(
      screen.getByRole("button", { name: "新建第一个服务器" }),
    );
    expect(
      screen.getByRole("dialog", { name: "新建服务器" }),
    ).toBeVisible();
    await user.click(
      screen.getByRole("button", { name: "关闭服务器编辑器" }),
    );
    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: "新建服务器" }),
      ).not.toBeInTheDocument(),
    );

    await user.click(screen.getByRole("button", { name: /打开服务器选择器/u }));
    await user.click(screen.getByRole("button", { name: "重新加载" }));
    await waitFor(() => expect(subscriber).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
  });

  it("刷新活动窗口数期间锁定删除确认并保留取消能力", async () => {
    const user = userEvent.setup();
    let publishReferenceChange: (() => void) | undefined;
    let finishReload:
      | ((snapshot: ConfigurationSnapshot) => void)
      | undefined;
    let snapshotAttempt = 0;
    const subscriber = vi.fn(async (onChange: () => void) => {
      publishReferenceChange = onChange;
      return () => undefined;
    });
    const { loader } = renderApp(
      () => {
        snapshotAttempt += 1;
        if (snapshotAttempt === 1) {
          return { servers: [localServer()], proxies: [] };
        }
        return new Promise<ConfigurationSnapshot>((resolve) => {
          finishReload = resolve;
        });
      },
      { windowReferenceSubscriber: subscriber },
    );

    await user.click(
      await screen.findByRole("button", {
        name: "选择服务器，未连接，打开服务器选择器",
      }),
    );
    await user.click(screen.getByRole("button", { name: "管理 本机开发" }));
    await user.click(screen.getByRole("menuitem", { name: "删除服务器" }));
    expect(screen.getByRole("button", { name: "删除服务器" })).toBeEnabled();

    act(() => publishReferenceChange?.());
    await waitFor(() => expect(loader).toHaveBeenCalledTimes(2));
    expect(screen.getByRole("button", { name: "正在确认" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "取消" })).toBeEnabled();

    await act(async () => {
      finishReload?.({
        servers: [{ ...localServer(), activeWindowCount: 2 }],
        proxies: [],
      });
    });
    expect(await screen.findByText("此服务器正被 2 个窗口使用")).toBeVisible();
    expect(screen.getByRole("button", { name: "删除服务器" })).toBeDisabled();
  });

  it("使用权威活动窗口数阻止删除，并在空闲时完成删除", async () => {
    const user = userEvent.setup();
    let authoritativeSnapshot: ConfigurationSnapshot = {
      servers: [{ ...localServer(), activeWindowCount: 2 }],
      proxies: [],
    };
    const deleteServerProfile = vi.fn(async () => {
      authoritativeSnapshot = { servers: [], proxies: [] };
    });
    const { testStore } = renderApp(() => authoritativeSnapshot, {
      mutationCommands: { deleteServerProfile },
    });

    await user.click(
      await screen.findByRole("button", {
        name: "选择服务器，未连接，打开服务器选择器",
      }),
    );
    await user.click(screen.getByRole("button", { name: "管理 本机开发" }));
    await user.click(screen.getByRole("menuitem", { name: "删除服务器" }));
    expect(screen.getByText("此服务器正被 2 个窗口使用")).toBeVisible();
    expect(screen.getByRole("button", { name: "删除服务器" })).toBeDisabled();
    expect(deleteServerProfile).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "取消" }));
    authoritativeSnapshot = {
      servers: [{ ...localServer(), activeWindowCount: 0 }],
      proxies: [],
    };
    testStore.dispatch(configurationSnapshotReplaced(authoritativeSnapshot));
    await user.click(
      screen.getByRole("button", { name: /打开服务器选择器/u }),
    );
    await user.click(screen.getByRole("button", { name: "管理 本机开发" }));
    await user.click(screen.getByRole("menuitem", { name: "删除服务器" }));
    await user.click(screen.getByRole("button", { name: "删除服务器" }));

    await waitFor(() => expect(deleteServerProfile).toHaveBeenCalledTimes(1));
    expect(deleteServerProfile).toHaveBeenCalledWith({
      serverId: SERVER_ID,
      expectedVersion: 1,
    });
    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: "删除服务器？" }),
      ).not.toBeInTheDocument(),
    );
  });

  it("打开新窗口失败时在主区域提示并允许用户再次发起", async () => {
    const user = userEvent.setup();
    const windowOpener = vi
      .fn<AppWindowOpener>()
      .mockRejectedValueOnce(new Error("private window failure"))
      .mockResolvedValueOnce({
        windowId: "33333333-3333-4333-8333-333333333333",
        label: "app-33333333-3333-4333-8333-333333333333",
      });
    renderApp(() => ({ servers: [localServer()], proxies: [] }), {
      windowOpener,
    });

    await user.click(
      await screen.findByRole("button", {
        name: "选择服务器，未连接，打开服务器选择器",
      }),
    );
    await user.click(
      screen.getByRole("button", { name: "在新窗口打开 本机开发" }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "无法打开新窗口，请重试",
    );
    expect(screen.queryByText("private window failure")).not.toBeInTheDocument();

    await user.click(
      screen.getByRole("button", { name: /打开服务器选择器/u }),
    );
    await user.click(
      screen.getByRole("button", { name: "在新窗口打开 本机开发" }),
    );
    await waitFor(() => expect(windowOpener).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
  });

  it("持久窗口绑定缺失服务器时退出连接骨架并展示可恢复错误", async () => {
    renderApp(() => ({ servers: [], proxies: [] }), {
      windowStateOptions: {
        loader: vi.fn(async () => ({
          windowId: "main",
          version: 2,
          serverId: SERVER_ID,
          updatedAtMs: 2,
        })),
      },
    });

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "当前窗口绑定的服务器不存在，请重新选择或新建服务器",
    );
    expect(screen.queryByText("正在连接 app-server")).not.toBeInTheDocument();
  });

  it("从新建服务器草稿完成连接与初始化测试且不保存配置", async () => {
    const user = userEvent.setup();
    let finishTest: (() => void) | undefined;
    const probe: ServerConnectionTestProbe = {
      run: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            finishTest = resolve;
          }),
      ),
      cancel: vi.fn(async () => undefined),
    };
    const requests: unknown[] = [];
    const createServerProfile = vi.fn();
    renderApp(() => ({ servers: [], proxies: [] }), {
      connectionTestOptions: {
        connectionIdFactory: () => "test-connection-1",
        probeFactory: ({ request }) => {
          requests.push(request);
          return probe;
        },
      },
      mutationCommands: { createServerProfile },
    });

    await user.click(
      await screen.findByRole("button", {
        name: "选择服务器，未连接，打开服务器选择器",
      }),
    );
    await user.click(screen.getByRole("button", { name: "新建第一个服务器" }));
    await user.type(screen.getByLabelText(/^名称/u), "本机测试");
    await user.type(screen.getByLabelText(/^可执行文件/u), "/usr/bin/codex");
    await user.click(screen.getByRole("button", { name: "测试连接" }));

    expect(screen.getByText("正在测试连接…")).toBeVisible();
    expect(requests).toEqual([
      {
        connectionId: "test-connection-1",
        configuration: {
          type: "localStdio",
          executablePath: "/usr/bin/codex",
          arguments: [],
          nonSensitiveEnvironment: {},
        },
        credentialSource: { type: "none" },
      },
    ]);
    expect(createServerProfile).not.toHaveBeenCalled();

    finishTest?.();
    expect(
      await screen.findByText("连接和 app-server 初始化成功"),
    ).toBeVisible();
    expect(screen.getByRole("dialog", { name: "新建服务器" })).toBeVisible();
    expect(createServerProfile).not.toHaveBeenCalled();
  });

  it("关闭测试中的服务器编辑器时等待取消完成并复用取消请求", async () => {
    const user = userEvent.setup();
    let finishCancel: (() => void) | undefined;
    const probe: ServerConnectionTestProbe = {
      run: vi.fn(() => new Promise<void>(() => undefined)),
      cancel: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            finishCancel = resolve;
          }),
      ),
    };
    renderApp(() => ({ servers: [], proxies: [] }), {
      connectionTestOptions: {
        connectionIdFactory: () => "test-connection-2",
        probeFactory: () => probe,
      },
    });

    await user.click(
      await screen.findByRole("button", {
        name: "选择服务器，未连接，打开服务器选择器",
      }),
    );
    await user.click(screen.getByRole("button", { name: "新建第一个服务器" }));
    await user.type(screen.getByLabelText(/^名称/u), "本机测试");
    await user.type(screen.getByLabelText(/^可执行文件/u), "/usr/bin/codex");
    await user.click(screen.getByRole("button", { name: "测试连接" }));

    const closeButton = screen.getByRole("button", {
      name: "关闭服务器编辑器",
    });
    await user.click(closeButton);
    await user.click(closeButton);

    expect(probe.cancel).toHaveBeenCalledTimes(1);
    expect(screen.getByText("正在取消测试连接…")).toBeVisible();
    expect(screen.getByRole("dialog", { name: "新建服务器" })).toBeVisible();

    finishCancel?.();
    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: "新建服务器" }),
      ).not.toBeInTheDocument(),
    );
    expect(probe.cancel).toHaveBeenCalledTimes(1);
  });

  it("测试取消失败时保留服务器编辑器并显示脱敏错误", async () => {
    const user = userEvent.setup();
    const probe: ServerConnectionTestProbe = {
      run: vi.fn(() => new Promise<void>(() => undefined)),
      cancel: vi.fn(async () => {
        throw new Error("DO_NOT_REPORT cancellation detail");
      }),
    };
    renderApp(() => ({ servers: [], proxies: [] }), {
      connectionTestOptions: {
        connectionIdFactory: () => "test-connection-3",
        probeFactory: () => probe,
      },
    });

    await user.click(
      await screen.findByRole("button", {
        name: "选择服务器，未连接，打开服务器选择器",
      }),
    );
    await user.click(screen.getByRole("button", { name: "新建第一个服务器" }));
    await user.type(screen.getByLabelText(/^名称/u), "本机测试");
    await user.type(screen.getByLabelText(/^可执行文件/u), "/usr/bin/codex");
    await user.click(screen.getByRole("button", { name: "测试连接" }));
    await user.click(screen.getByRole("button", { name: "关闭服务器编辑器" }));

    expect(
      await screen.findByText("无法确认测试连接已关闭，请关闭当前窗口后重试"),
    ).toBeVisible();
    expect(screen.getByRole("dialog", { name: "新建服务器" })).toBeVisible();
    expect(document.body).not.toHaveTextContent("DO_NOT_REPORT");
    expect(probe.cancel).toHaveBeenCalledTimes(1);
  });

  it("加载已保存服务器并从侧栏完成连接初始化", async () => {
    const user = userEvent.setup();
    const sessions: ConfiguredServerSessionFactoryOptions[] = [];
    const sessionFactory: ConfiguredServerSessionFactory = (options) => {
      sessions.push(options);
      return {
        async start() {
          options.onStateChange({
            phase: "ready",
            connectionStage: null,
            initializeResponse: null,
            errorCode: null,
          });
          return {};
        },
        async close() {},
      };
    };
    renderApp(() => ({ servers: [localServer()], proxies: [] }), {
      sessionFactory,
    });

    const trigger = await screen.findByRole("button", {
      name: "选择服务器，未连接，打开服务器选择器",
    });
    await user.click(trigger);
    await user.click(screen.getByRole("button", { name: "连接 本机开发" }));

    await waitFor(() => expect(sessions).toHaveLength(1));
    expect(sessions[0]?.request).toEqual({
      connectionId: "connection-1",
      serverId: SERVER_ID,
    });
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent("开始一个新任务"),
    );
    expect(
      screen.queryByRole("dialog", { name: "服务器" }),
    ).not.toBeInTheDocument();
  });

  it("创建凭据部分失败后保留敏感草稿并以新版本续接", async () => {
    const user = userEvent.setup();
    let authoritativeSnapshot: ConfigurationSnapshot = {
      servers: [],
      proxies: [],
    };
    const createServerProfile = vi.fn(async () => {
      const profile = remoteServer(1, false);
      authoritativeSnapshot = { servers: [profile], proxies: [] };
      return profile;
    });
    const updateServerProfile = vi.fn(async (request) => {
      expect(request).toMatchObject({
        serverId: SERVER_ID,
        expectedVersion: 1,
      });
      const profile = remoteServer(2, false);
      authoritativeSnapshot = { servers: [profile], proxies: [] };
      return profile;
    });
    const setServerCredential = vi
      .fn()
      .mockRejectedValueOnce(
        new ConfigurationCommandError("credentialStorageFailed"),
      )
      .mockImplementationOnce(async (request) => {
        expect(request).toMatchObject({
          serverId: SERVER_ID,
          expectedVersion: 2,
          credential: { type: "bearerToken", value: "retry-secret" },
        });
        const profile = remoteServer(3, true);
        authoritativeSnapshot = { servers: [profile], proxies: [] };
        return profile;
      });
    renderApp(() => authoritativeSnapshot, {
      mutationCommands: {
        createServerProfile,
        updateServerProfile,
        setServerCredential,
      },
    });

    await user.click(
      await screen.findByRole("button", {
        name: "选择服务器，未连接，打开服务器选择器",
      }),
    );
    await user.click(screen.getByRole("button", { name: "新建第一个服务器" }));
    await user.type(screen.getByLabelText(/^名称/u), "远程开发");
    await user.click(screen.getByRole("radio", { name: /远程 WebSocket/u }));
    await user.type(
      screen.getByLabelText(/^WebSocket URL/u),
      "wss://codex.example.test/app-server",
    );
    await user.selectOptions(screen.getByLabelText(/^认证方式/u), "bearer");
    await user.type(screen.getByLabelText(/^Bearer 令牌/u), "retry-secret");
    await user.click(screen.getByRole("button", { name: "保存" }));

    expect(
      await screen.findByText(/服务器配置已保存，但新凭据未保存/u),
    ).toBeVisible();
    expect(screen.getByLabelText(/^Bearer 令牌/u)).toHaveValue("retry-secret");
    expect(createServerProfile).toHaveBeenCalledTimes(1);
    expect(setServerCredential).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: "编辑服务器" }),
      ).not.toBeInTheDocument(),
    );
    expect(updateServerProfile).toHaveBeenCalledTimes(1);
    expect(setServerCredential).toHaveBeenCalledTimes(2);
  });

  it("编辑当前服务器配置部分保存后仍提示重连并保留编辑器", async () => {
    const user = userEvent.setup();
    let authoritativeSnapshot: ConfigurationSnapshot = {
      servers: [localServer()],
      proxies: [],
    };
    const sessions: ConfiguredServerSessionFactoryOptions[] = [];
    const sessionFactory: ConfiguredServerSessionFactory = (options) => {
      sessions.push(options);
      return {
        async start() {
          options.onStateChange({
            phase: "ready",
            connectionStage: null,
            initializeResponse: null,
            errorCode: null,
          });
          return {};
        },
        async close() {},
      };
    };
    const updateServerProfile = vi.fn(async () => {
      const profile = {
        ...localServer(),
        version: 2,
        updatedAtMs: 2,
      };
      authoritativeSnapshot = { servers: [profile], proxies: [] };
      return profile;
    });
    const setServerCredential = vi.fn(async () => {
      throw new ConfigurationCommandError("credentialStorageFailed");
    });
    renderApp(() => authoritativeSnapshot, {
      sessionFactory,
      mutationCommands: { setServerCredential, updateServerProfile },
    });

    await user.click(
      await screen.findByRole("button", {
        name: "选择服务器，未连接，打开服务器选择器",
      }),
    );
    await user.click(screen.getByRole("button", { name: "连接 本机开发" }));
    await waitFor(() => expect(sessions).toHaveLength(1));
    await user.click(
      await screen.findByRole("button", {
        name: "本机开发，已连接，打开服务器选择器",
      }),
    );
    await user.click(screen.getByRole("button", { name: "管理 本机开发" }));
    await user.click(screen.getByRole("menuitem", { name: "编辑服务器" }));
    await user.click(screen.getByRole("button", { name: "添加敏感环境变量" }));
    await user.type(screen.getByLabelText("敏感环境变量名称 1"), "API_TOKEN");
    await user.type(screen.getByLabelText("敏感环境变量值 1"), "retry-secret");
    await user.click(screen.getByRole("button", { name: "保存" }));

    expect(
      await screen.findByText(/服务器配置已保存，但新凭据未保存/u),
    ).toBeVisible();
    expect(
      screen.getByRole("dialog", { name: "立即重连服务器？" }),
    ).toBeVisible();
    await user.click(screen.getByRole("button", { name: "稍后应用" }));

    expect(
      screen.queryByRole("dialog", { name: "立即重连服务器？" }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("dialog", { name: "编辑服务器" })).toBeVisible();
    expect(screen.getByLabelText("敏感环境变量值 1")).toHaveValue(
      "retry-secret",
    );
    expect(updateServerProfile).toHaveBeenCalledTimes(1);
    expect(setServerCredential).toHaveBeenCalledTimes(1);
  });

  it.each([
    { choice: "立即重连", expectedSessionCount: 2 },
    { choice: "稍后应用", expectedSessionCount: 1 },
  ])(
    "编辑当前服务器保存后可选择$choice",
    async ({ choice, expectedSessionCount }) => {
      const user = userEvent.setup();
      let authoritativeSnapshot: ConfigurationSnapshot = {
        servers: [localServer()],
        proxies: [],
      };
      const sessions: ConfiguredServerSessionFactoryOptions[] = [];
      const sessionFactory: ConfiguredServerSessionFactory = (options) => {
        sessions.push(options);
        return {
          async start() {
            options.onStateChange({
              phase: "ready",
              connectionStage: null,
              initializeResponse: null,
              errorCode: null,
            });
            return {};
          },
          async close() {},
        };
      };
      const updateServerProfile = vi.fn(async () => {
        const profile = {
          ...localServer(),
          name: "本机更新",
          version: 2,
          updatedAtMs: 2,
        };
        authoritativeSnapshot = { servers: [profile], proxies: [] };
        return profile;
      });
      renderApp(() => authoritativeSnapshot, {
        sessionFactory,
        mutationCommands: { updateServerProfile },
      });

      await user.click(
        await screen.findByRole("button", {
          name: "选择服务器，未连接，打开服务器选择器",
        }),
      );
      await user.click(screen.getByRole("button", { name: "连接 本机开发" }));
      await waitFor(() => expect(sessions).toHaveLength(1));

      await user.click(
        await screen.findByRole("button", {
          name: "本机开发，已连接，打开服务器选择器",
        }),
      );
      await user.click(screen.getByRole("button", { name: "管理 本机开发" }));
      await user.click(screen.getByRole("menuitem", { name: "编辑服务器" }));
      await user.clear(screen.getByLabelText(/^名称/u));
      await user.type(screen.getByLabelText(/^名称/u), "本机更新");
      await user.click(screen.getByRole("button", { name: "保存" }));

      const reconnectDialog = await screen.findByRole("dialog", {
        name: "立即重连服务器？",
      });
      expect(reconnectDialog).toHaveTextContent("本机更新");
      await user.click(screen.getByRole("button", { name: choice }));

      await waitFor(() => expect(sessions).toHaveLength(expectedSessionCount));
      expect(updateServerProfile).toHaveBeenCalledWith(
        expect.objectContaining({
          serverId: SERVER_ID,
          expectedVersion: 1,
          name: "本机更新",
        }),
      );
      expect(
        screen.queryByRole("dialog", { name: "立即重连服务器？" }),
      ).not.toBeInTheDocument();
    },
  );

  it("首次加载失败时锁定空态并可重试到权威列表", async () => {
    const user = userEvent.setup();
    let loadAttempt = 0;
    const { loader } = renderApp(() => {
      loadAttempt += 1;
      if (loadAttempt === 1) {
        throw new Error("private backend detail");
      }
      return { servers: [localServer()], proxies: [] };
    });

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "无法加载服务器配置，请重试",
    );
    expect(screen.queryByText("还没有保存的服务器")).not.toBeInTheDocument();
    expect(
      screen.queryByText("private backend detail"),
    ).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "重试连接" }));
    await waitFor(() => expect(loader).toHaveBeenCalledTimes(2));
    await user.click(
      screen.getByRole("button", {
        name: "选择服务器，未连接，打开服务器选择器",
      }),
    );
    expect(await screen.findByText("本机开发")).toBeVisible();
    expect(screen.getByRole("button", { name: "连接 本机开发" })).toBeEnabled();
  });
});

describe("collectHighRiskServerIds", () => {
  it("识别目标服务器自身的宽松证书策略", () => {
    const server = withRemoteConfiguration(remoteServer(1, false), {
      tlsCertificatePolicy: "allowInvalidCertificate",
    });

    expect(collectHighRiskServerIds([server], []).has(SERVER_ID)).toBe(true);
  });

  it("识别所选 HTTPS 代理的宽松证书策略", () => {
    const server = withRemoteConfiguration(remoteServer(1, false), {
      proxyId: PROXY_ID,
    });

    expect(
      collectHighRiskServerIds(
        [server],
        [httpProxy("allowInvalidCertificate")],
      ).has(SERVER_ID),
    ).toBe(true);
  });

  it("不把严格代理、未引用的高风险代理或本机服务器标为高风险", () => {
    const strictProxiedServer = withRemoteConfiguration(
      remoteServer(1, false),
      { proxyId: PROXY_ID },
    );
    const directServer = remoteServer(1, false);

    expect(
      collectHighRiskServerIds([strictProxiedServer], [httpProxy("strict")])
        .size,
    ).toBe(0);
    expect(
      collectHighRiskServerIds(
        [directServer],
        [httpProxy("allowInvalidCertificate")],
      ).size,
    ).toBe(0);
    expect(
      collectHighRiskServerIds(
        [localServer()],
        [httpProxy("allowInvalidCertificate")],
      ).size,
    ).toBe(0);
  });
});
