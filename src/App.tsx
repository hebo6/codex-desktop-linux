import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  useConfigurationProfiles,
  type ConfigurationProfilesLoader,
} from "./app/useConfigurationProfiles";
import {
  connectionStageDetail,
  useConfiguredServerConnection,
  type ConfiguredServerConnectionControllerOptions,
} from "./app/useConfiguredServerConnection";
import { useConversation } from "./app/useConversation";
import { useComposerCapabilities } from "./app/useComposerCapabilities";
import {
  useServerProfileMutations,
  type ServerProfileMutationCommands,
} from "./app/useServerProfileMutations";
import {
  useProxyProfileMutations,
  type ProxyProfileMutationCommands,
} from "./app/useProxyProfileMutations";
import { useServerThreads, type RestoredThread, type ThreadSummary } from "./app/useServerThreads";
import { useServerInteractions } from "./app/useServerInteractions";
import { useAccountRateLimits } from "./app/useAccountRateLimits";
import { usePreferences } from "./app/usePreferences";
import {
  useServerConnectionTest,
  type ServerConnectionTestControllerOptions,
} from "./app/useServerConnectionTest";
import {
  useWindowState,
  type WindowStateControllerOptions,
} from "./app/useWindowState";
import { ConnectionShell } from "./components/ConnectionShell";
import {
  ConversationPlaceholder,
  ConversationView,
} from "./components/ConversationView";
import { ConversationWorkspace } from "./components/ConversationWorkspace";
import { Composer } from "./components/Composer";
import { ApprovalPanel } from "./components/ApprovalPanel";
import { RateLimitIndicator } from "./components/RateLimitIndicator";
import { ExternalLinkDialog } from "./components/ExternalLinkDialog";
import { FilePreviewDialog, type FilePreviewRequest } from "./components/FilePreviewDialog";
import { PlaintextCredentialConfirmDialog } from "./components/PlaintextCredentialConfirmDialog";
import { ServerDeleteDialog } from "./components/ServerDeleteDialog";
import { ServerEditorDialog } from "./components/ServerEditorDialog";
import { ServerReconnectDialog } from "./components/ServerReconnectDialog";
import { SettingsDialog, type SettingsSection } from "./components/SettingsDialog";
import { ProxyEditorDialog } from "./components/ProxyEditorDialog";
import { ProxyDeleteDialog } from "./components/ProxyDeleteDialog";
import type { ProxyEditorMode, ProxyEditorSubmission } from "./components/proxyEditorModel";
import { ServerSwitcher } from "./components/ServerSwitcher";
import { ThreadDeleteDialog } from "./components/ThreadDeleteDialog";
import { ThreadForkDialog } from "./components/ThreadForkDialog";
import { ThreadQuickSwitcher } from "./components/ThreadQuickSwitcher";
import type {
  ServerConnectionStartResult,
  ServerConnectionView,
} from "./components/ServerSwitcher";
import type {
  CredentialStorageStatus,
  ProxyId,
  ProxyProfile,
  ServerId,
  ServerProfile,
} from "./configuration";
import { resolveLink, type ExtractedLink } from "./content/linkResolver";
import type {
  ServerEditorMode,
  ServerEditorSubmission,
} from "./components/serverEditorModel";
import { useAppSelector } from "./store/hooks";
import { selectConfiguration } from "./store/store";
import {
  openAppWindow,
  subscribeWindowServerReferenceChanges,
  type WindowServerReferenceSubscriber,
} from "./transport/windowState";
import { openExternalUrl, pickLocalDirectory } from "./transport/systemDialog";
import {
  serverThreadCache,
  type ServerThreadCache,
} from "./transport/offlineCache";
import {
  preferencesStore as defaultPreferencesStore,
  type AppPreferences,
  type PreferencesStore,
} from "./transport/preferences";
import {
  desktopNotificationService,
  type DesktopNotificationService,
} from "./transport/desktopNotifications";
import type { ProxyConnectionTestInput } from "./transport/serverConnectionTest";
import {
  subscribeDeepLinkTargets,
  type DeepLinkTarget,
  type DeepLinkTargetSubscriber,
} from "./transport/deepLink";
import {
  subscribeConfiguredServerStatuses,
  type ConfiguredServerStatus,
  type ConfiguredServerStatusSubscriber,
} from "./transport/configuredServerStatuses";
import { getCredentialStorageStatus } from "./transport/configuration";

export type AppWindowOpener = typeof openAppWindow;
export type CredentialStorageStatusLoader = () => Promise<CredentialStorageStatus>;

export interface AppProps {
  readonly configurationLoader?: ConfigurationProfilesLoader;
  readonly credentialStorageStatusLoader?: CredentialStorageStatusLoader;
  readonly connectionOptions?: ConfiguredServerConnectionControllerOptions;
  readonly connectionTestOptions?: ServerConnectionTestControllerOptions;
  readonly mutationCommands?: Partial<ServerProfileMutationCommands>;
  readonly proxyMutationCommands?: Partial<ProxyProfileMutationCommands>;
  readonly windowStateOptions?: WindowStateControllerOptions;
  readonly windowOpener?: AppWindowOpener;
  readonly windowReferenceSubscriber?: WindowServerReferenceSubscriber;
  readonly threadCache?: ServerThreadCache;
  readonly preferencesStore?: PreferencesStore;
  readonly notificationService?: DesktopNotificationService;
  readonly deepLinkSubscriber?: DeepLinkTargetSubscriber;
  readonly configuredServerStatusSubscriber?: ConfiguredServerStatusSubscriber;
}

interface ActiveServerEditor {
  readonly sessionId: string;
  readonly mode: ServerEditorMode;
  readonly createdProfileContinuationId?: ServerId;
}

interface PendingServerReconnect {
  readonly serverId: ServerId;
  readonly serverName: string;
}

interface ActiveProxyEditor {
  readonly mode: ProxyEditorMode;
  readonly origin: "settings" | "server";
}

type PendingPlaintextCredentialConfirmation =
  | {
      readonly kind: "server";
      readonly submission: ServerEditorSubmission;
    }
  | {
      readonly kind: "proxy";
      readonly submission: ProxyEditorSubmission;
    };

function matchesPersistedProxyDraft(
  profile: ProxyProfile,
  submission: ProxyEditorSubmission,
): boolean {
  if (
    submission.name !== profile.name ||
    submission.credentialIntent.type !== "keep" ||
    JSON.stringify(submission.configuration) !== JSON.stringify(profile.configuration)
  ) {
    return false;
  }
  const storedHostKey = profile.sshHostKey;
  const draftHostKey = submission.sshHostKey;
  return storedHostKey === undefined
    ? draftHostKey === undefined
    : draftHostKey !== undefined &&
        draftHostKey.host === storedHostKey.host &&
        draftHostKey.port === storedHostKey.port &&
        draftHostKey.algorithm === storedHostKey.algorithm &&
        draftHostKey.sha256Fingerprint === storedHostKey.sha256Fingerprint;
}

export function collectHighRiskServerIds(
  servers: readonly ServerProfile[],
  proxies: readonly ProxyProfile[],
): ReadonlySet<ServerId> {
  const proxiesById = new Map(proxies.map((proxy) => [proxy.proxyId, proxy]));
  const serverIds = new Set<ServerId>();
  for (const server of servers) {
    const configuration = server.configuration;
    if (configuration.type !== "remoteWebSocket") {
      continue;
    }
    const proxy =
      configuration.proxyId === undefined
        ? undefined
        : proxiesById.get(configuration.proxyId);
    const proxyAllowsInvalidCertificate =
      proxy?.configuration.type === "httpConnect" &&
      proxy.configuration.tlsCertificatePolicy === "allowInvalidCertificate";
    if (
      configuration.tlsCertificatePolicy === "allowInvalidCertificate" ||
      proxyAllowsInvalidCertificate
    ) {
      serverIds.add(server.serverId);
    }
  }
  return serverIds;
}

export function App({
  configurationLoader,
  credentialStorageStatusLoader = getCredentialStorageStatus,
  connectionOptions,
  connectionTestOptions,
  mutationCommands,
  proxyMutationCommands,
  windowStateOptions,
  windowOpener = openAppWindow,
  windowReferenceSubscriber = subscribeWindowServerReferenceChanges,
  threadCache = serverThreadCache,
  preferencesStore = defaultPreferencesStore,
  notificationService = desktopNotificationService,
  deepLinkSubscriber = subscribeDeepLinkTargets,
  configuredServerStatusSubscriber = subscribeConfiguredServerStatuses,
}: AppProps = {}) {
  const configuration = useAppSelector(selectConfiguration);
  const windowState = useWindowState(windowStateOptions);
  const profiles = useConfigurationProfiles(
    configurationLoader,
    windowState.windowState !== null,
  );
  const connection = useConfiguredServerConnection(connectionOptions);
  const serverThreads = useServerThreads(
    connection.threadClient,
    windowState.windowState?.currentThreadId ?? null,
    threadCache,
    windowState.windowState?.serverId ?? null,
  );
  const conversation = useConversation({
    client: connection.conversationClient,
    currentThreadId: windowState.windowState?.currentThreadId ?? null,
    restoredThread: serverThreads.restoredThread,
    onThreadCreated: async (response) => {
      const cancelPreparation = serverThreads.prepareStartedThread(response);
      try {
        await windowState.updateSession(response.thread.id, null);
      } catch (error) {
        cancelPreparation();
        throw error;
      }
    },
  });
  const [draftCwd, setDraftCwd] = useState<string | null>(null);
  const selectedServerId = windowState.windowState?.serverId ?? null;
  const selectedServer = selectedServerId === null
    ? undefined
    : configuration.serversById[selectedServerId];
  const configuredCwd = selectedServer?.configuration.type === "localStdio"
    ? selectedServer.configuration.defaultWorkingDirectory ?? null
    : null;
  const recentCwds = useMemo(
    () => recentWorkingDirectories(serverThreads.threads),
    [serverThreads.threads],
  );
  const composerCwd = serverThreads.restoredThread?.metadata.cwd
    ?? draftCwd
    ?? recentCwds[0]
    ?? configuredCwd;
  const composerCapabilities = useComposerCapabilities(
    connection.capabilityClient,
    composerCwd,
  );
  const serverInteractions = useServerInteractions(connection.interactionClient);
  const accountRateLimits = useAccountRateLimits(connection.accountClient);
  const preferences = usePreferences(preferencesStore);
  const connectionTest = useServerConnectionTest(connectionTestOptions);
  const mutations = useServerProfileMutations(
    profiles.runMutation,
    mutationCommands,
  );
  const proxyMutations = useProxyProfileMutations(
    profiles.runMutation,
    proxyMutationCommands,
  );
  const [editor, setEditor] = useState<ActiveServerEditor | null>(null);
  const [pendingReconnect, setPendingReconnect] =
    useState<PendingServerReconnect | null>(null);
  const [proxyEditor, setProxyEditor] = useState<ActiveProxyEditor | null>(null);
  const [credentialStorageChecking, setCredentialStorageChecking] =
    useState(false);
  const [
    pendingPlaintextCredentialConfirmation,
    setPendingPlaintextCredentialConfirmation,
  ] = useState<PendingPlaintextCredentialConfirmation | null>(null);
  const [deletingProxyId, setDeletingProxyId] = useState<ProxyId | null>(null);
  const [deletingServerId, setDeletingServerId] = useState<ServerId | null>(
    null,
  );
  const [deletingThreadId, setDeletingThreadId] = useState<string | null>(null);
  const [pendingForkTurnId, setPendingForkTurnId] = useState<string | null>(null);
  const [forkingTurnId, setForkingTurnId] = useState<string | null>(null);
  const [forkError, setForkError] = useState<string | null>(null);
  const [contentError, setContentError] = useState<string | null>(null);
  const [previewRequest, setPreviewRequest] = useState<FilePreviewRequest | null>(null);
  const [externalLink, setExternalLink] = useState<ExtractedLink | null>(null);
  const [settingsSection, setSettingsSection] = useState<SettingsSection | null>(null);
  const [recentConnectionError, setRecentConnectionError] = useState<string | null>(null);
  const [quickSwitcherOpen, setQuickSwitcherOpen] = useState(false);
  const [shortcutStatus, setShortcutStatus] = useState<string | null>(null);
  const [notificationPermission, setNotificationPermission] = useState(
    () => notificationService.permission(),
  );
  const [openingExternalLink, setOpeningExternalLink] = useState(false);
  const trustedDomainsRef = useRef(new Set<string>());
  const [windowActionError, setWindowActionError] = useState<string | null>(
    null,
  );
  const [pendingDeepLink, setPendingDeepLink] = useState<DeepLinkTarget | null>(null);
  const [configuredServerStatuses, setConfiguredServerStatuses] = useState<
    readonly ConfiguredServerStatus[]
  >([]);
  const [windowReferenceError, setWindowReferenceError] = useState<
    string | null
  >(null);
  const [
    windowReferenceSubscriptionAttempt,
    setWindowReferenceSubscriptionAttempt,
  ] = useState(0);
  const editorSequenceRef = useRef(0);
  const recordedProxyTestRef = useRef<string | null>(null);
  const persistedProxyTestRef = useRef<ProxyProfile | null>(null);
  const conversationActivityRef = useRef<{
    readonly threadId: string | null;
    readonly activeTurnId: string | null;
  }>({ threadId: null, activeTurnId: null });
  const notifiedApprovalKeysRef = useRef(new Set<string>());
  const previousConnectionPhaseRef = useRef(connection.view.phase);
  const appliedWindowServerRef = useRef<ServerId | null | undefined>(
    undefined,
  );
  const deepLinkInFlightRef = useRef(false);

  const servers = useMemo(
    () =>
      configuration.serverIds.flatMap((serverId) => {
        const profile = configuration.serversById[serverId];
        return profile === undefined ? [] : [profile];
      }),
    [configuration],
  );
  const proxies = useMemo(
    () =>
      configuration.proxyIds.flatMap((proxyId) => {
        const profile = configuration.proxiesById[proxyId];
        return profile === undefined ? [] : [profile];
      }),
    [configuration],
  );
  const highRiskServerIds = useMemo(
    () => collectHighRiskServerIds(servers, proxies),
    [proxies, servers],
  );
  const boundServerId = windowState.windowState?.serverId ?? null;
  const windowId = windowState.windowState?.windowId ?? null;
  const deletingServer =
    deletingServerId === null
      ? null
      : (configuration.serversById[deletingServerId] ?? null);
  const deletingProxy = deletingProxyId === null
    ? null
    : (configuration.proxiesById[deletingProxyId] ?? null);
  const deletingThread =
    deletingThreadId === null
      ? null
      : (serverThreads.threads.find(({ id }) => id === deletingThreadId) ?? null);
  const boundServerName =
    boundServerId === null
      ? "当前服务器"
      : (configuration.serversById[boundServerId]?.name ?? "当前服务器");
  const boundServer =
    boundServerId === null ? null : (configuration.serversById[boundServerId] ?? null);
  const restoredThread = serverThreads.restoredThread;
  const displayedRestoredThread = useMemo(
    () => restoredThread === null
      ? null
      : ({
          ...restoredThread,
          turns:
            conversation.turns.length === 0 && restoredThread.turns.length > 0
              ? restoredThread.turns
              : conversation.turns,
        }),
    [conversation.turns, restoredThread],
  );

  useEffect(() => {
    let disposed = false;
    let release: (() => void) | null = null;
    void configuredServerStatusSubscriber((statuses) => {
      if (!disposed) setConfiguredServerStatuses(statuses);
    }).then(
      (unsubscribe) => {
        if (disposed) unsubscribe();
        else release = unsubscribe;
      },
      () => {
        if (!disposed) setConfiguredServerStatuses([]);
      },
    );
    return () => {
      disposed = true;
      release?.();
    };
  }, [configuredServerStatusSubscriber]);

  useEffect(() => {
    setNotificationPermission(notificationService.permission());
  }, [notificationService]);

  useEffect(() => {
    const threadId = windowState.windowState?.currentThreadId ?? null;
    const previous = conversationActivityRef.current;
    const latestTurn = displayedRestoredThread?.turns.at(-1);
    if (
      preferences.preferences.notifyTaskComplete &&
      previous.threadId === threadId &&
      previous.activeTurnId !== null &&
      conversation.activeTurnId === null &&
      latestTurn?.status === "completed"
    ) {
      notificationService.show({
        title: "Codex 任务已完成",
        body: "返回对应窗口查看结果",
        tag: `task:${windowId ?? "main"}:${threadId ?? "draft"}`,
      });
    }
    conversationActivityRef.current = {
      threadId,
      activeTurnId: conversation.activeTurnId,
    };
  }, [
    conversation.activeTurnId,
    displayedRestoredThread?.turns,
    notificationService,
    preferences.preferences.notifyTaskComplete,
    windowId,
    windowState.windowState?.currentThreadId,
  ]);

  useEffect(() => {
    const currentKeys = new Set(serverInteractions.pending.map(({ key }) => key));
    const hasNewRequest = serverInteractions.pending.some(
      ({ key }) => !notifiedApprovalKeysRef.current.has(key),
    );
    if (hasNewRequest && preferences.preferences.notifyApproval) {
      notificationService.show({
        title: "Codex 正在等待审批",
        body: "返回对应窗口查看并处理请求",
        tag: `approval:${windowId ?? "main"}`,
      });
    }
    notifiedApprovalKeysRef.current = currentKeys;
  }, [
    notificationService,
    preferences.preferences.notifyApproval,
    serverInteractions.pending,
    windowId,
  ]);

  useEffect(() => {
    const previous = previousConnectionPhaseRef.current;
    if (
      preferences.preferences.notifyConnectionFailure &&
      previous !== "error" &&
      connection.view.phase === "error"
    ) {
      notificationService.show({
        title: "Codex 连接失败",
        body: "返回窗口查看连接诊断或重试",
        tag: `connection:${windowId ?? "main"}:${boundServerId ?? "unbound"}`,
      });
    }
    previousConnectionPhaseRef.current = connection.view.phase;
    if (connection.view.phase === "error" && connection.view.detail !== null) {
      setRecentConnectionError(connection.view.detail);
    }
  }, [
    boundServerId,
    connection.view.detail,
    connection.view.phase,
    notificationService,
    preferences.preferences.notifyConnectionFailure,
    windowId,
  ]);

  useEffect(() => {
    if (
      connection.view.phase !== "ready" ||
      boundServerId === null ||
      displayedRestoredThread === null ||
      serverThreads.offline
    ) {
      return;
    }
    const timeout = window.setTimeout(() => {
      void threadCache.save({
        serverId: boundServerId,
        threads: serverThreads.threads,
        nextThreadCursor: serverThreads.nextThreadCursor,
        currentThreadId: displayedRestoredThread.metadata.id,
        restoredThread: displayedRestoredThread,
      }).catch(() => undefined);
    }, 750);
    return () => window.clearTimeout(timeout);
  }, [boundServerId, connection.view.phase, displayedRestoredThread, serverThreads.nextThreadCursor, serverThreads.offline, serverThreads.threads, threadCache]);
  const contentTitle =
    serverThreads.currentThreadDeleted
      ? "会话已删除"
      : restoredThread === null
        ? windowState.windowState?.currentThreadId === undefined
          ? "新任务"
          : "正在恢复会话"
        : threadDisplayTitle(restoredThread.metadata);
  const contentSubtitle = restoredThread?.metadata.cwd ?? boundServerName;
  const isWindowStateLoading =
    windowState.status === "idle" ||
    windowState.status === "loading";
  const boundServerUnavailable =
    profiles.status === "ready" &&
    boundServerId !== null &&
    configuration.serversById[boundServerId] === undefined;
  const applicationError =
    windowState.error ??
    profiles.error ??
    windowActionError ??
    (boundServerUnavailable
      ? "当前窗口绑定的服务器不存在，请重新选择或新建服务器"
      : null);
  const configurationErrorSummary = windowState.error ?? profiles.error;
  const shellDetail =
    applicationError ??
    connection.view.detail;
  const isRestoringBoundServer =
    boundServerId !== null && connection.currentServerId !== boundServerId;

  useEffect(() => {
    document.title = serverThreads.currentThreadDeleted
      ? `会话已删除 — ${boundServerName}`
      : restoredThread === null
        ? `Codex Desktop Linux — ${boundServerName}`
        : `${threadDisplayTitle(restoredThread.metadata)} — ${boundServerName}`;
  }, [boundServerName, restoredThread, serverThreads.currentThreadDeleted]);

  useEffect(() => {
    if (shortcutStatus === null) return;
    const timeout = window.setTimeout(() => setShortcutStatus(null), 2_000);
    return () => window.clearTimeout(timeout);
  }, [shortcutStatus]);

  useEffect(() => {
    setDraftCwd(null);
  }, [boundServerId]);

  useEffect(() => {
    if (windowId === null) {
      return;
    }

    let disposed = false;
    let unlisten: (() => void) | null = null;
    void windowReferenceSubscriber(profiles.reload).then(
      (release) => {
        if (disposed) {
          release();
        } else {
          unlisten = release;
          setWindowReferenceError(null);
        }
      },
      () => {
        if (!disposed) {
          setWindowReferenceError("无法同步其他窗口状态，请重试");
        }
      },
    );
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [
    profiles.reload,
    windowId,
    windowReferenceSubscriber,
    windowReferenceSubscriptionAttempt,
  ]);

  useEffect(() => {
    let disposed = false;
    let release: (() => void) | null = null;
    void deepLinkSubscriber(
      (target) => {
        if (!disposed) setPendingDeepLink(target);
      },
      () => {
        if (!disposed) setWindowActionError("无法读取深链目标");
      },
    ).then((unsubscribe) => {
      if (disposed) unsubscribe();
      else release = unsubscribe;
    });
    return () => {
      disposed = true;
      release?.();
    };
  }, [deepLinkSubscriber]);

  useEffect(() => {
    if (
      pendingDeepLink === null ||
      deepLinkInFlightRef.current ||
      profiles.status !== "ready" ||
      windowState.status !== "ready"
    ) {
      return;
    }
    if (configuration.serversById[pendingDeepLink.serverId] === undefined) {
      setWindowActionError("深链引用的服务器尚未保存");
      setPendingDeepLink(null);
      return;
    }
    deepLinkInFlightRef.current = true;
    const target = pendingDeepLink;
    void (async () => {
      try {
        if ((windowState.windowState?.serverId ?? null) !== target.serverId) {
          await windowState.bindServer(target.serverId);
          appliedWindowServerRef.current = undefined;
          profiles.reload();
        }
        if (target.threadId !== undefined) {
          await windowState.updateSession(target.threadId, null);
        }
        setWindowActionError(null);
      } catch {
        setWindowActionError("无法打开深链目标，请重试");
      } finally {
        deepLinkInFlightRef.current = false;
        setPendingDeepLink((current) => current === target ? null : current);
      }
    })();
  }, [configuration.serversById, pendingDeepLink, profiles, windowState]);

  useEffect(() => {
    if (
      profiles.status !== "ready" ||
      windowState.status !== "ready" ||
      windowState.windowState === null
    ) {
      return;
    }
    const serverId = windowState.windowState.serverId ?? null;
    if (appliedWindowServerRef.current === serverId) {
      return;
    }
    if (serverId !== null && configuration.serversById[serverId] === undefined) {
      return;
    }
    appliedWindowServerRef.current = serverId;
    if (serverId !== null) {
      void connection.connect(serverId);
    }
  }, [
    configuration.serversById,
    connection,
    profiles.status,
    windowState.status,
    windowState.windowState,
  ]);
  const serverConnectionViews = useMemo<
    Readonly<Record<string, ServerConnectionView | undefined>>
  >(() => {
    const views: Record<string, ServerConnectionView> = {};
    for (const status of configuredServerStatuses) {
      views[status.serverId] = {
        phase: status.phase,
        errorSummary: null,
      };
    }
    if (connection.currentServerId !== null) {
      views[connection.currentServerId] = {
        phase: connection.view.phase,
        errorSummary:
          connection.view.phase === "error" ? connection.view.detail : null,
      };
    }
    return views;
  }, [configuredServerStatuses, connection.currentServerId, connection.view]);

  const nextEditorSessionId = (): string => {
    editorSequenceRef.current += 1;
    return `server-editor-${editorSequenceRef.current}`;
  };
  const openCreateEditor = async () => {
    if (profiles.status !== "ready") {
      return;
    }
    try {
      await connectionTest.reset();
    } catch {
      return;
    }
    mutations.resetSave();
    setEditor({
      sessionId: nextEditorSessionId(),
      mode: { type: "create" },
    });
  };
  const openEditEditor = async (serverId: ServerId) => {
    if (profiles.status !== "ready") {
      return;
    }
    const profile = configuration.serversById[serverId];
    if (profile === undefined) {
      return;
    }
    try {
      await connectionTest.reset();
    } catch {
      return;
    }
    mutations.resetSave();
    setEditor({
      sessionId: nextEditorSessionId(),
      mode: { type: "edit", profile },
    });
  };
  const closeEditor = async () => {
    const activeEditor = editor;
    if (activeEditor === null) {
      return;
    }
    try {
      await connectionTest.cancel();
    } catch {
      return;
    }
    mutations.resetSave();
    setPendingPlaintextCredentialConfirmation((current) =>
      current?.kind === "server" ? null : current,
    );
    setEditor((current) =>
      current?.sessionId === activeEditor.sessionId ? null : current,
    );
  };
  const saveEditor = async (
    submission: ServerEditorSubmission,
    plaintextFallbackConfirmed = false,
  ): Promise<void> => {
    const activeEditor = editor;
    if (activeEditor === null) {
      return;
    }
    const outcome = await mutations.saveProfile(
      activeEditor.mode,
      submission,
      plaintextFallbackConfirmed,
    );
    const promptReconnectForCurrentEdit = (profile: ServerProfile) => {
      if (
        activeEditor.mode.type === "edit" &&
        boundServerId === profile.serverId
      ) {
        setPendingReconnect({
          serverId: profile.serverId,
          serverName: profile.name,
        });
      }
    };
    if (outcome.status === "saved") {
      void connectionTest.reset().catch(() => undefined);
      setEditor((current) =>
        current?.sessionId === activeEditor.sessionId ? null : current,
      );
      promptReconnectForCurrentEdit(outcome.profile);
      return;
    }
    if (outcome.status === "partiallySaved") {
      const confirmationRequired =
        outcome.errorCode === "plaintextCredentialConfirmationRequired";
      if (
        outcome.dataEffect === "configurationSavedCredentialNotSaved" &&
        !confirmationRequired
      ) {
        promptReconnectForCurrentEdit(outcome.profile);
      }
      setEditor((current) => {
        if (current?.sessionId !== activeEditor.sessionId) {
          return current;
        }
        return {
          ...current,
          mode: { type: "edit", profile: outcome.profile },
          ...(activeEditor.mode.type === "create"
            ? { createdProfileContinuationId: outcome.profile.serverId }
            : {}),
        };
      });
      if (confirmationRequired) {
        setPendingPlaintextCredentialConfirmation({
          kind: "server",
          submission,
        });
      }
    }
  };

  const openCreateProxyEditor = async (origin: ActiveProxyEditor["origin"]) => {
    try {
      await connectionTest.reset();
    } catch {
      return;
    }
    proxyMutations.resetSave();
    persistedProxyTestRef.current = null;
    setProxyEditor({ mode: { type: "create" }, origin });
  };

  const openEditProxyEditor = async (
    proxyId: ProxyId,
    origin: ActiveProxyEditor["origin"] = "settings",
  ) => {
    const profile = configuration.proxiesById[proxyId];
    if (profile === undefined) return;
    try {
      await connectionTest.reset();
    } catch {
      return;
    }
    proxyMutations.resetSave();
    persistedProxyTestRef.current = null;
    setProxyEditor({ mode: { type: "edit", profile }, origin });
  };

  const closeProxyEditor = async () => {
    try {
      await connectionTest.cancel();
    } catch {
      return;
    }
    proxyMutations.resetSave();
    persistedProxyTestRef.current = null;
    setPendingPlaintextCredentialConfirmation((current) =>
      current?.kind === "proxy" ? null : current,
    );
    setProxyEditor(null);
  };

  const saveProxyEditor = async (
    submission: ProxyEditorSubmission,
    plaintextFallbackConfirmed = false,
  ) => {
    const active = proxyEditor;
    if (active === null) return;
    const outcome = await proxyMutations.saveProfile(
      active.mode,
      submission,
      plaintextFallbackConfirmed,
    );
    const confirmationRequired =
      outcome.status === "partiallySaved" &&
      outcome.errorCode === "plaintextCredentialConfirmationRequired";
    if (outcome.status === "saved") {
      setProxyEditor(null);
    } else if (outcome.status === "partiallySaved") {
      setProxyEditor({ ...active, mode: { type: "edit", profile: outcome.profile } });
      if (confirmationRequired) {
        setPendingPlaintextCredentialConfirmation({
          kind: "proxy",
          submission,
        });
      }
    }
    if (
      outcome.status !== "failed" &&
      !confirmationRequired &&
      active.mode.type === "edit" &&
      boundServer?.configuration.type === "remoteWebSocket" &&
      boundServer.configuration.proxyId === active.mode.profile.proxyId
    ) {
      setPendingReconnect({ serverId: boundServer.serverId, serverName: boundServer.name });
    }
  };

  const prepareCredentialSave = async (
    pending: PendingPlaintextCredentialConfirmation,
  ): Promise<void> => {
    if (pending.submission.credentialIntent.type !== "set") {
      if (pending.kind === "server") {
        await saveEditor(pending.submission);
      } else {
        await saveProxyEditor(pending.submission);
      }
      return;
    }

    setCredentialStorageChecking(true);
    let plaintextConfirmationRequired = false;
    try {
      const status = await credentialStorageStatusLoader();
      plaintextConfirmationRequired = status.backend === "plaintextFile";
    } catch {
      // The Rust write boundary still denies an unconfirmed plaintext fallback.
    } finally {
      setCredentialStorageChecking(false);
    }

    if (plaintextConfirmationRequired) {
      setPendingPlaintextCredentialConfirmation(pending);
      return;
    }
    if (pending.kind === "server") {
      await saveEditor(pending.submission);
    } else {
      await saveProxyEditor(pending.submission);
    }
  };

  const confirmPlaintextCredentialSave = (): void => {
    const pending = pendingPlaintextCredentialConfirmation;
    if (pending === null) return;
    setPendingPlaintextCredentialConfirmation(null);
    if (pending.kind === "server") {
      void saveEditor(pending.submission, true);
    } else {
      void saveProxyEditor(pending.submission, true);
    }
  };

  const testProxy = (serverId: ServerId, submission: ProxyEditorSubmission) => {
    const active = proxyEditor;
    const server = configuration.serversById[serverId];
    if (active === null || server?.configuration.type !== "remoteWebSocket") return;
    const credentialSource: ProxyConnectionTestInput["credentialSource"] =
      submission.credentialIntent.type === "set"
        ? {
            type: "provided",
            credential: submission.credentialIntent.credential,
          }
        : submission.credentialIntent.type === "keep" &&
            active.mode.type === "edit" &&
            active.mode.profile.credentialConfigured
          ? {
              type: "stored",
              proxyId: active.mode.profile.proxyId,
              expectedVersion: active.mode.profile.version,
            }
          : { type: "none" };
    const proxy: ProxyConnectionTestInput = {
      configuration: submission.configuration,
      credentialSource,
      ...(submission.sshHostKey === undefined
        ? {}
        : { sshHostKey: submission.sshHostKey }),
    };
    persistedProxyTestRef.current = active.mode.type === "edit" &&
      matchesPersistedProxyDraft(active.mode.profile, submission)
        ? active.mode.profile
        : null;
    void connectionTest.test(
      { type: "edit", profile: server },
      {
        name: server.name,
        configuration: {
          type: "remoteWebSocket",
          url: server.configuration.url,
          authentication: server.configuration.authentication,
          nonSensitiveHeaders: server.configuration.nonSensitiveHeaders,
          connectTimeoutMs: server.configuration.connectTimeoutMs,
          tlsCertificatePolicy: server.configuration.tlsCertificatePolicy,
          plaintextConfirmed: server.configuration.plaintextConfirmed,
        },
        credentialIntent: { type: "keep" },
      },
      proxy,
    );
  };

  const removeProxyHostKey = async () => {
    const active = proxyEditor;
    if (active?.mode.type !== "edit" || active.mode.profile.sshHostKey === undefined) return;
    const outcome = await proxyMutations.removeHostKey(active.mode.profile);
    if (outcome.status === "saved") {
      setProxyEditor((current) => current === null
        ? null
        : { ...current, mode: { type: "edit", profile: outcome.profile } });
    }
  };

  const confirmProxyHostKey = async (_prompt: unknown) => {
    await connectionTest.reset().catch(() => undefined);
  };

  const deleteProxy = async (profile: ProxyProfile) => {
    const outcome = await proxyMutations.deleteProfile(profile.proxyId, profile.version);
    if (outcome.status === "deleted") setDeletingProxyId(null);
  };

  useEffect(() => {
    const testState = connectionTest.state;
    const profile = persistedProxyTestRef.current;
    if (
      profile === null ||
      (testState?.type !== "succeeded" && testState?.type !== "failed")
    ) {
      if (testState?.type === "testing" || proxyEditor === null) recordedProxyTestRef.current = null;
      return;
    }
    const status = testState.type === "succeeded" ? "succeeded" : "failed";
    const key = `${profile.proxyId}:${profile.version}:${status}`;
    if (recordedProxyTestRef.current === key) return;
    recordedProxyTestRef.current = key;
    void proxyMutations.recordTest(profile, status).then((updated) => {
      if (updated === null) return;
      setProxyEditor((current) =>
        current?.mode.type === "edit" &&
        current.mode.profile.proxyId === updated.proxyId &&
        current.mode.profile.version === updated.version
          ? { ...current, mode: { type: "edit", profile: updated } }
          : current,
      );
    });
  }, [connectionTest.state, proxyEditor, proxyMutations.recordTest]);

  const deleteServer = async (
    serverId: ServerId,
    expectedVersion: number,
  ): Promise<void> => {
    const outcome = await mutations.deleteProfile(serverId, expectedVersion);
    if (outcome.status === "deleted") {
      setDeletingServerId((current) =>
        current === serverId ? null : current,
      );
    }
  };

  const reloadApplicationState = () => {
    setWindowActionError(null);
    if (windowReferenceError !== null) {
      setWindowReferenceError(null);
      setWindowReferenceSubscriptionAttempt((attempt) => attempt + 1);
    }
    profiles.reload();
    if (windowState.status === "error") {
      windowState.reload();
    }
  };

  const openThread = async (threadId: string): Promise<void> => {
    if (windowState.status !== "ready") {
      return;
    }
    setWindowActionError(null);
    try {
      await windowState.updateSession(threadId, null);
    } catch {
      setWindowActionError("无法打开会话，请重试");
    }
  };

  const openNewTask = async (): Promise<void> => {
    if (windowState.status !== "ready") {
      return;
    }
    setWindowActionError(null);
    const inheritedCwd = restoredThread?.metadata.cwd ?? null;
    const previousDraftCwd = draftCwd;
    setDraftCwd(inheritedCwd);
    try {
      await windowState.updateSession(null, `draft:${crypto.randomUUID()}`);
    } catch {
      setDraftCwd(previousDraftCwd);
      setWindowActionError("无法新建任务，请重试");
    }
  };

  const openNewWindowTask = useCallback(() => {
    if (boundServerId === null) return;
    setWindowActionError(null);
    void windowOpener({ serverId: boundServerId }).then(
      () => profiles.reload(),
      () => setWindowActionError("无法在新窗口新建任务，请重试"),
    );
  }, [boundServerId, profiles.reload, windowOpener]);

  useEffect(() => {
    const handleGlobalShortcut = (event: KeyboardEvent) => {
      if (!event.ctrlKey || event.altKey || event.metaKey) return;
      const key = event.key.toLowerCase();
      const editing = event.target instanceof HTMLElement && (
        event.target.matches("input, textarea, select") || event.target.isContentEditable
      );
      if (key === ",") {
        event.preventDefault();
        setSettingsSection("appearance");
      } else if (key === "l") {
        const composer = document.querySelector<HTMLTextAreaElement>("[data-composer-input]");
        if (composer !== null && !composer.disabled) {
          event.preventDefault();
          composer.focus();
        }
      } else if (key === "n" && event.shiftKey && boundServerId !== null) {
        event.preventDefault();
        openNewWindowTask();
      } else if (key === "k" && !event.shiftKey && !editing) {
        event.preventDefault();
        setQuickSwitcherOpen(true);
      } else if (key === "c" && event.shiftKey && !editing) {
        const markdown = latestAgentMarkdown(displayedRestoredThread);
        if (markdown !== null) {
          event.preventDefault();
          void navigator.clipboard.writeText(markdown).then(
            () => setShortcutStatus("已复制当前 AI 回答 Markdown"),
            () => setShortcutStatus("无法复制当前 AI 回答"),
          );
        }
      }
    };
    window.addEventListener("keydown", handleGlobalShortcut);
    return () => window.removeEventListener("keydown", handleGlobalShortcut);
  }, [boundServerId, displayedRestoredThread, openNewWindowTask]);

  const updatePreferences = (patch: Partial<AppPreferences>) => {
    const notificationKeys = [
      "notifyTaskComplete",
      "notifyApproval",
      "notifyConnectionFailure",
    ] as const;
    const enabling = notificationKeys.some((key) => patch[key] === true);
    if (!enabling || notificationPermission === "granted") {
      preferences.update(patch);
      return;
    }
    if (notificationPermission === "denied" || notificationPermission === "unsupported") {
      preferences.update(disableRequestedNotifications(patch));
      return;
    }
    void notificationService.requestPermission().then(
      (permission) => {
        setNotificationPermission(permission);
        preferences.update(permission === "granted" ? patch : disableRequestedNotifications(patch));
      },
      () => {
        setNotificationPermission("unsupported");
        preferences.update(disableRequestedNotifications(patch));
      },
    );
  };

  const deleteThread = async (threadId: string): Promise<void> => {
    const deleted = await serverThreads.deleteThread(threadId);
    if (!deleted) {
      return;
    }
    setDeletingThreadId((current) => (current === threadId ? null : current));
    if (
      windowState.status === "ready" &&
      (windowState.windowState?.currentThreadId ?? null) === threadId
    ) {
      try {
        await windowState.updateSession(null, `draft:${crypto.randomUUID()}`);
      } catch {
        setWindowActionError("会话已删除，但无法更新当前窗口状态");
      }
    }
  };

  const forkThread = async (turnId: string): Promise<void> => {
    const threadId = windowState.windowState?.currentThreadId ?? null;
    if (
      connection.threadClient === null ||
      threadId === null ||
      forkingTurnId !== null ||
      windowState.status !== "ready"
    ) {
      return;
    }
    setForkingTurnId(turnId);
    setForkError(null);
    try {
      const response = await connection.threadClient.forkThread(threadId, turnId).result;
      await windowState.updateSession(response.thread.id, null);
      setPendingForkTurnId(null);
    } catch {
      setForkError("无法创建会话分支，原会话未受影响，请重试");
    } finally {
      setForkingTurnId(null);
    }
  };

  const openConfirmedExternalLink = async (
    link: ExtractedLink,
    trustDomain: boolean,
  ): Promise<void> => {
    setOpeningExternalLink(true);
    setContentError(null);
    try {
      await openExternalUrl(link.url);
      if (trustDomain) {
        trustedDomainsRef.current.add(link.domain);
      }
      setExternalLink(null);
    } catch {
      setContentError("无法使用系统默认浏览器打开此网页");
    } finally {
      setOpeningExternalLink(false);
    }
  };

  const openContentLink = (raw: string) => {
    const resolved = resolveLink(raw, composerCwd);
    setContentError(null);
    switch (resolved.type) {
      case "file":
        setPreviewRequest({
          path: resolved.path,
          line: resolved.line,
          endLine: resolved.endLine,
          column: resolved.column,
        });
        return;
      case "external":
        if (trustedDomainsRef.current.has(resolved.domain)) {
          void openConfirmedExternalLink(resolved, false);
        } else {
          setExternalLink(resolved);
        }
        return;
      case "anchor":
        document.getElementById(resolved.id)?.scrollIntoView({ block: "start" });
        return;
      case "blocked":
        setContentError(resolved.reason);
    }
  };

  const openDiff = (rawPath: string, diff: string) => {
    const resolved = resolveLink(rawPath, composerCwd);
    if (resolved.type !== "file") {
      setContentError(resolved.type === "blocked" ? resolved.reason : "无法解析文件变更路径");
      return;
    }
    setContentError(null);
    setPreviewRequest({ path: resolved.path, diff });
  };

  const connectServer = async (
    serverId: ServerId,
  ): Promise<ServerConnectionStartResult> => {
    setWindowActionError(null);
    if (profiles.status !== "ready" || windowState.status !== "ready") {
      setWindowActionError("服务器配置仍在加载，请稍后重试");
      return "cancelled";
    }
    try {
      await windowState.bindServer(serverId);
      appliedWindowServerRef.current = undefined;
      profiles.reload();
      return "started";
    } catch {
      setWindowActionError("无法切换服务器，请重试");
      return "cancelled";
    }
  };

  const openServerInNewWindow = (serverId: ServerId) => {
    setWindowActionError(null);
    void windowOpener({ serverId }).then(
      () => profiles.reload(),
      () => setWindowActionError("无法打开新窗口，请重试"),
    );
  };

  const openThreadInNewWindow = (threadId: string) => {
    if (boundServerId === null) return;
    setWindowActionError(null);
    void windowOpener({ serverId: boundServerId, threadId }).then(
      () => profiles.reload(),
      () => setWindowActionError("无法在新窗口打开会话，请重试"),
    );
  };

  const serverControl = (
    <ServerSwitcher
      configurationErrorSummary={configurationErrorSummary}
      configurationWarningSummary={windowReferenceError}
      currentServerId={boundServerId}
      highRiskServerIds={highRiskServerIds}
      isLoading={
        isWindowStateLoading ||
        profiles.status === "idle" ||
        profiles.status === "loading"
      }
      onConnect={connectServer}
      onCreate={() => void openCreateEditor()}
      onDelete={(serverId) => {
        mutations.resetDelete();
        setDeletingServerId(serverId);
      }}
      onEdit={(serverId) => void openEditEditor(serverId)}
      onOpenInNewWindow={openServerInNewWindow}
      onReloadConfiguration={reloadApplicationState}
      serverConnectionViews={serverConnectionViews}
      servers={servers}
    />
  );

  return (
    <>
      <ConnectionShell
        announcement={shortcutStatus}
        archivedThread={serverThreads.archivedThread}
        contentSubtitle={contentSubtitle}
        contentTitle={contentTitle}
        currentThreadId={windowState.windowState?.currentThreadId ?? null}
        hasMoreThreads={serverThreads.nextThreadCursor !== null}
        loadingMoreThreads={serverThreads.loadingMoreThreads}
        mainContent={
          <ConversationWorkspace
            composer={
              connection.view.phase === "ready" && (
                restoredThread !== null ||
                windowState.windowState?.currentThreadId === undefined
              ) ? (
                <Composer
                  activeTurn={conversation.activeTurnId !== null}
                  capabilitiesError={composerCapabilities.error}
                  canRunImmediateCommands={
                    (windowState.windowState?.currentThreadId ?? null) !== null
                  }
                  cwd={composerCwd}
                  draftKey={composerDraftKey(
                    windowState.windowState?.windowId ?? null,
                    boundServerId,
                    windowState.windowState?.draftKey ?? null,
                    windowState.windowState?.currentThreadId ?? null,
                  )}
                  error={conversation.error}
                  interactionPanel={
                    <ApprovalPanel
                      onOpenLink={openContentLink}
                      onRespond={serverInteractions.respond}
                      pending={serverInteractions.pending}
                      resolvedElsewhereCount={serverInteractions.resolvedElsewhereCount}
                    />
                  }
                  models={composerCapabilities.models}
                  modelsLoading={composerCapabilities.modelsLoading}
                  mentionReferences={composerCapabilities.mentionReferences}
                  mentionsError={composerCapabilities.mentionsError}
                  mentionsLoading={composerCapabilities.mentionsLoading}
                  onLoadMentions={composerCapabilities.loadMentions}
                  onLoadSkills={composerCapabilities.loadSkills}
                  onCwdChange={setDraftCwd}
                  {...(boundServer?.configuration.type === "localStdio"
                    ? { onPickCwd: pickLocalDirectory }
                    : {})}
                  onRunImmediateCommand={conversation.runImmediateCommand}
                  onOpenSettings={() => setSettingsSection("appearance")}
                  onSearchFiles={composerCapabilities.searchFiles}
                  onSend={conversation.sendInput}
                  onStop={conversation.stop}
                  permissions={composerCapabilities.permissions}
                  permissionsLoading={composerCapabilities.permissionsLoading}
                  recentCwds={recentCwds}
                  skills={composerCapabilities.skills}
                  skillsLoading={composerCapabilities.skillsLoading}
                  showProjectPicker={windowState.windowState?.currentThreadId === undefined}
                  stopping={conversation.stopping}
                  submitting={conversation.submitting}
                />
              ) : null
            }
          >
            {displayedRestoredThread !== null ? (
              <ConversationView
                actionError={forkError ?? contentError}
                hasOlderTurns={displayedRestoredThread.nextCursor !== null}
                loadingOlderTurns={serverThreads.loadingOlderTurns}
                onLoadOlderTurns={serverThreads.loadOlderTurns}
                onOpenDiff={openDiff}
                onOpenLink={openContentLink}
                {...(serverThreads.offline ? {} : { onForkTurn: (turnId: string, isLatest: boolean) => {
                  setForkError(null);
                  if (isLatest) {
                    void forkThread(turnId);
                  } else {
                    setPendingForkTurnId(turnId);
                  }
                } })}
                restoredThread={displayedRestoredThread}
              />
            ) : (
              <ConversationPlaceholder
                kind={
                  serverThreads.currentThreadDeleted
                    ? "deleted"
                    : windowState.windowState?.currentThreadId === undefined
                      ? "blank"
                      : serverThreads.phase === "error"
                        ? "error"
                        : "loading"
                }
                onNewTask={() => void openNewTask()}
              />
            )}
          </ConversationWorkspace>
        }
        onArchiveThread={(threadId) => void serverThreads.archiveThread(threadId)}
        onDeleteThread={setDeletingThreadId}
        onLoadMoreThreads={() => void serverThreads.loadMoreThreads()}
        onNewTask={() => void openNewTask()}
        onRefreshThreads={() => void serverThreads.refreshThreads()}
        onSearchThreads={() => setQuickSwitcherOpen(true)}
        onOpenThread={(threadId) => void openThread(threadId)}
        onOpenThreadInNewWindow={openThreadInNewWindow}
        onUndoArchive={() => void serverThreads.undoArchive()}
        pendingThreadIds={serverThreads.pendingThreadIds}
        removingThreadIds={serverThreads.removingThreadIds}
        {...(shellDetail === null ? {} : { detail: shellDetail })}
        {...(applicationError !== null
          ? { onRetry: reloadApplicationState }
          : profiles.status === "ready"
            ? { onRetry: () => void connection.retry() }
            : {})}
        phase={
          applicationError !== null
            ? "error"
            : isWindowStateLoading || isRestoringBoundServer
              ? "connecting"
              : connection.view.phase
        }
        reconnect={connection.reconnect}
        refreshingThreads={serverThreads.refreshingThreads}
        onStopReconnect={connection.stopReconnect}
        onOpenDiagnostics={() => setSettingsSection("diagnostics")}
        onOpenSettings={() => setSettingsSection("appearance")}
        onSidebarWidthChange={(sidebarWidth) =>
          preferences.update({ sidebarWidth })
        }
        offline={serverThreads.offline}
        offlineSyncedAt={serverThreads.lastSyncedAt}
        serverControl={serverControl}
        sidebarWidth={preferences.preferences.sidebarWidth}
        threadListError={serverThreads.error}
        threadListPhase={serverThreads.phase}
        threads={serverThreads.threads}
        topbarAccessory={
          <RateLimitIndicator
            data={accountRateLimits.data}
            error={accountRateLimits.error}
            loading={accountRateLimits.loading}
            onRefresh={accountRateLimits.refresh}
            refreshing={accountRateLimits.refreshing}
            updatedAt={accountRateLimits.updatedAt}
          />
        }
      />

      <ServerDeleteDialog
        affectedWindowCount={deletingServer?.activeWindowCount ?? 0}
        checkingWindowReferences={
          profiles.status !== "ready" ||
          windowState.status !== "ready" ||
          windowReferenceError !== null
        }
        errorSummary={mutations.deleteState.error}
        onCancel={() => {
          mutations.resetDelete();
          setDeletingServerId(null);
        }}
        onConfirm={(serverId, expectedVersion) =>
          void deleteServer(serverId, expectedVersion)
        }
        saving={mutations.deleteState.saving}
        server={deletingServer}
      />

      <ThreadDeleteDialog
        deleting={
          deletingThreadId !== null &&
          serverThreads.pendingThreadIds.includes(deletingThreadId)
        }
        error={
          deletingThreadId !== null && serverThreads.error === "无法删除会话"
            ? serverThreads.error
            : null
        }
        onCancel={() => setDeletingThreadId(null)}
        onConfirm={(threadId) => void deleteThread(threadId)}
        serverName={boundServerName}
        thread={deletingThread}
      />

      <ThreadForkDialog
        error={pendingForkTurnId === null ? null : forkError}
        forking={forkingTurnId !== null}
        onCancel={() => {
          if (forkingTurnId === null) {
            setPendingForkTurnId(null);
            setForkError(null);
          }
        }}
        onConfirm={(turnId) => void forkThread(turnId)}
        turnId={pendingForkTurnId}
      />

      <FilePreviewDialog
        client={connection.fileClient}
        defaultWrap={preferences.preferences.codeWrap}
        onClose={() => setPreviewRequest(null)}
        onOpenLink={openContentLink}
        request={previewRequest}
        serverName={boundServerName}
        workspacePath={composerCwd}
      />

      <ExternalLinkDialog
        link={externalLink}
        opening={openingExternalLink}
        onCancel={() => {
          if (!openingExternalLink) setExternalLink(null);
        }}
        onConfirm={(trustDomain) => {
          if (externalLink !== null) void openConfirmedExternalLink(externalLink, trustDomain);
        }}
      />

      <SettingsDialog
        currentConnectionStage={connection.connectionStage === null ? null : connectionStageDetail(connection.connectionStage)}
        connectionPhase={connection.view.phase}
        currentServer={boundServer}
        currentServerName={boundServerName}
        initialSection={settingsSection ?? "appearance"}
        onClose={() => setSettingsSection(null)}
        onEditServer={(serverId) => {
          setSettingsSection(null);
          void openEditEditor(serverId);
        }}
        onNewServer={() => {
          setSettingsSection(null);
          void openCreateEditor();
        }}
        onConnectServer={(serverId) => {
          setSettingsSection(null);
          void connectServer(serverId);
        }}
        onOpenServerInNewWindow={(serverId) => {
          setSettingsSection(null);
          openServerInNewWindow(serverId);
        }}
        onDeleteServer={(serverId) => {
          setSettingsSection(null);
          mutations.resetDelete();
          setDeletingServerId(serverId);
        }}
        onEditProxy={(proxyId) => void openEditProxyEditor(proxyId)}
        onNewProxy={() => void openCreateProxyEditor("settings")}
        onDeleteProxy={(proxyId) => {
          proxyMutations.resetDelete();
          setDeletingProxyId(proxyId);
        }}
        onBeforeClearAllLocalData={() => connection.disconnect()}
        onAllLocalDataCleared={() => window.location.reload()}
        onUpdatePreferences={updatePreferences}
        notificationPermission={notificationPermission}
        open={settingsSection !== null}
        permissionProfiles={composerCapabilities.permissions}
        preferences={preferences.preferences}
        preferencesError={preferences.error}
        preferencesLoading={preferences.loading}
        preferencesSaving={preferences.saving}
        preferencesStore={preferences.store}
        proxies={proxies}
        recentConnectionError={recentConnectionError}
        servers={servers}
        serverConnectionViews={serverConnectionViews}
      />

      <ThreadQuickSwitcher
        currentThreadId={windowState.windowState?.currentThreadId ?? null}
        onClose={() => setQuickSwitcherOpen(false)}
        onOpenThread={(threadId) => void openThread(threadId)}
        open={quickSwitcherOpen}
        threads={serverThreads.threads}
      />

      <ProxyDeleteDialog
        deleting={proxyMutations.deleteState.saving}
        error={proxyMutations.deleteState.error}
        onCancel={() => {
          proxyMutations.resetDelete();
          setDeletingProxyId(null);
        }}
        onConfirm={(profile) => void deleteProxy(profile)}
        proxy={deletingProxy}
        servers={servers}
      />

      {editor === null ? null : (
        <ServerEditorDialog
          {...(editor.createdProfileContinuationId === undefined
            ? {}
            : {
                createdProfileContinuationId:
                  editor.createdProfileContinuationId,
              })}
          {...(mutations.saveState.error === null
            ? {}
            : { error: mutations.saveState.error })}
          editorSessionId={editor.sessionId}
          mode={editor.mode}
          onCancel={() => void closeEditor()}
          onCancelTest={() =>
            void connectionTest.cancel().catch(() => undefined)
          }
          onSubmit={(submission) =>
            void prepareCredentialSave({ kind: "server", submission })
          }
          onCreateProxy={() => void openCreateProxyEditor("server")}
          onTest={(submission) => connectionTest.test(editor.mode, submission)}
          open
          proxies={proxies}
          saving={mutations.saveState.saving || credentialStorageChecking}
          {...(connectionTest.state === undefined
            ? {}
            : { testState: connectionTest.state })}
        />
      )}


      {proxyEditor === null ? null : (
        <ProxyEditorDialog
          error={proxyMutations.saveState.error ?? undefined}
          mode={proxyEditor.mode}
          onCancel={() => void closeProxyEditor()}
          onCancelTest={() => void connectionTest.cancel().catch(() => undefined)}
          onConfirmHostKey={(prompt) => void confirmProxyHostKey(prompt)}
          onRemoveHostKey={proxyEditor.mode.type === "edit" && proxyEditor.mode.profile.sshHostKey !== undefined
            ? () => void removeProxyHostKey()
            : undefined}
          onSubmit={(submission) =>
            void prepareCredentialSave({ kind: "proxy", submission })
          }
          onTest={testProxy}
          open
          remoteServers={servers.filter(({ configuration }) => configuration.type === "remoteWebSocket")}
          saving={proxyMutations.saveState.saving || credentialStorageChecking}
          testState={connectionTest.state}
        />
      )}

      <PlaintextCredentialConfirmDialog
        onCancel={() => setPendingPlaintextCredentialConfirmation(null)}
        onConfirm={confirmPlaintextCredentialSave}
        open={pendingPlaintextCredentialConfirmation !== null}
      />

      <ServerReconnectDialog
        onLater={() => setPendingReconnect(null)}
        onReconnect={() => {
          const reconnect = pendingReconnect;
          setPendingReconnect(null);
          if (
            reconnect !== null &&
            boundServerId === reconnect.serverId
          ) {
            void connection.retry();
          }
        }}
        serverName={pendingReconnect?.serverName ?? null}
      />
    </>
  );
}

function threadDisplayTitle(thread: ThreadSummary): string {
  const name = thread.name?.trim();
  if (name !== undefined && name.length > 0) {
    return name;
  }
  const preview = thread.preview.trim().split(/\r?\n/u, 1)[0]?.trim();
  return preview === undefined || preview.length === 0 ? "未命名会话" : preview;
}

export function latestAgentMarkdown(thread: RestoredThread | null): string | null {
  if (thread === null) {
    return null;
  }
  for (let turnIndex = thread.turns.length - 1; turnIndex >= 0; turnIndex -= 1) {
    const turn = thread.turns[turnIndex];
    if (turn === undefined) {
      continue;
    }
    for (let itemIndex = turn.items.length - 1; itemIndex >= 0; itemIndex -= 1) {
      const item = turn.items[itemIndex];
      if (item?.type === "agentMessage" && item.text.trim().length > 0) {
        return item.text;
      }
    }
  }
  return null;
}

export function disableRequestedNotifications(
  patch: Partial<AppPreferences>,
): Partial<AppPreferences> {
  return {
    ...patch,
    ...(patch.notifyTaskComplete === true ? { notifyTaskComplete: false } : {}),
    ...(patch.notifyApproval === true ? { notifyApproval: false } : {}),
    ...(patch.notifyConnectionFailure === true
      ? { notifyConnectionFailure: false }
      : {}),
  };
}

export function recentWorkingDirectories(
  threads: readonly Pick<ThreadSummary, "cwd">[],
): readonly string[] {
  const directories = new Set<string>();
  for (const thread of threads) {
    const cwd = thread.cwd.trim();
    if (cwd.length > 0) {
      directories.add(cwd);
    }
  }
  return Object.freeze([...directories]);
}

function composerDraftKey(
  windowId: string | null,
  serverId: string | null,
  draftKey: string | null,
  threadId: string | null,
): string | null {
  if (windowId === null || serverId === null) {
    return null;
  }
  return `${windowId}:${serverId}:${draftKey ?? threadId ?? "new"}`;
}
