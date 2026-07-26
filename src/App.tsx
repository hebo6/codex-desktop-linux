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
import { useBackgroundTerminals } from "./app/useBackgroundTerminals";
import { useComposerCapabilities } from "./app/useComposerCapabilities";
import { useTurnPlan } from "./app/useTurnPlan";
import {
  useServerProfileMutations,
  type ServerProfileMutationCommands,
} from "./app/useServerProfileMutations";
import {
  useProxyProfileMutations,
  type ProxyProfileMutationCommands,
} from "./app/useProxyProfileMutations";
import {
  useServerThreads,
  type RestoredThread,
  type ServerThreadsClient,
  type ThreadSummary,
} from "./app/useServerThreads";
import {
  useThreadSession,
  type ThreadSessionState,
} from "./app/useThreadSession";
import { useServerInteractions } from "./app/useServerInteractions";
import { useAccountRateLimits } from "./app/useAccountRateLimits";
import { useAccountTokenUsage } from "./app/useAccountTokenUsage";
import { usePreferences } from "./app/usePreferences";
import {
  useServerConnectionTest,
  type ServerConnectionTestControllerOptions,
} from "./app/useServerConnectionTest";
import {
  useWindowState,
  WindowStateControllerError,
  type WindowStateControllerOptions,
} from "./app/useWindowState";
import { ConnectionShell } from "./components/ConnectionShell";
import {
  ConversationPlaceholder,
  ConversationView,
  type CommandLocationRequest,
} from "./components/ConversationView";
import { ConversationWorkspace } from "./components/ConversationWorkspace";
import { Composer } from "./components/Composer";
import { ApprovalPanel } from "./components/ApprovalPanel";
import { BackgroundCommandPanel } from "./components/BackgroundCommandPanel";
import { TaskPlanPanel } from "./components/TaskPlanPanel";
import { RateLimitIndicator } from "./components/RateLimitIndicator";
import { ExternalLinkDialog } from "./components/ExternalLinkDialog";
import { FilePreviewDialog, type FilePreviewRequest } from "./components/FilePreviewDialog";
import { KeyboardShortcutsDialog } from "./components/KeyboardShortcutsDialog";
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
import { ThreadTabs, type ThreadTabView } from "./components/ThreadTabs";
import { WindowResizeHandles } from "./components/WindowResizeHandles";
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
import type { ThreadStartResponse } from "./protocol/generated";
import { resolveLink, type ExtractedLink } from "./content/linkResolver";
import type {
  ServerEditorMode,
  ServerEditorSubmission,
} from "./components/serverEditorModel";
import { useAppSelector } from "./store/hooks";
import { selectConfiguration } from "./store/store";
import {
  openAppWindow,
  subscribeWindowStateChanges,
  subscribeWindowServerReferenceChanges,
  type WindowTab,
  type WindowStateSubscriber,
  type WindowServerReferenceSubscriber,
} from "./transport/windowState";
import { openExternalUrl, pickLocalDirectory } from "./transport/systemDialog";
import {
  preferencesStore as defaultPreferencesStore,
  type AppPreferences,
  type PreferencesStore,
} from "./transport/preferences";
import {
  desktopNotificationService,
  type DesktopNotificationPermission,
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
import {
  draftStore as persistentDraftStore,
  createTransientDraftStore,
  type DraftStore,
} from "./transport/drafts";
import {
  openProtocolDebugWindow,
  protocolDebugAvailable,
} from "./transport/protocolTrace";

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
  readonly windowStateSubscriber?: WindowStateSubscriber;
  readonly preferencesStore?: PreferencesStore;
  readonly notificationService?: DesktopNotificationService;
  readonly deepLinkSubscriber?: DeepLinkTargetSubscriber;
  readonly configuredServerStatusSubscriber?: ConfiguredServerStatusSubscriber;
  readonly draftStore?: DraftStore;
  readonly protocolDebugAvailabilityLoader?: () => Promise<boolean>;
  readonly protocolDebugWindowOpener?: () => Promise<void>;
}

interface DraftThreadPresence {
  readonly keyPrefix: string | null;
  readonly threadIds: ReadonlySet<string>;
}

interface DraftPresenceOverrides {
  readonly keyPrefix: string | null;
  readonly entries: Map<string, boolean>;
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
  windowStateSubscriber = subscribeWindowStateChanges,
  preferencesStore = defaultPreferencesStore,
  notificationService = desktopNotificationService,
  deepLinkSubscriber = subscribeDeepLinkTargets,
  configuredServerStatusSubscriber = subscribeConfiguredServerStatuses,
  draftStore = persistentDraftStore,
  protocolDebugAvailabilityLoader = protocolDebugAvailable,
  protocolDebugWindowOpener = openProtocolDebugWindow,
}: AppProps = {}) {
  const configuration = useAppSelector(selectConfiguration);
  const windowState = useWindowState(windowStateOptions);
  const windowTabs = windowState.windowState?.tabs ?? EMPTY_WINDOW_TABS;
  const activeTabId = windowState.windowState?.activeTabId ?? null;
  const activeTab = activeTabId === null
    ? null
    : windowTabs.find(({ id }) => id === activeTabId) ?? null;
  const currentThreadId = activeTab?.threadId ?? null;
  const [tabSessions, setTabSessions] = useState<
    ReadonlyMap<string, TabThreadSession>
  >(() => new Map());
  const activeTabSession = activeTabId === null || currentThreadId === null
    ? null
    : tabSessions.get(activeTabId) ?? null;
  const activeThreadSession =
    activeTabSession?.threadId === currentThreadId
      ? activeTabSession.state
      : null;
  const restoredThread =
    activeThreadSession?.restoredThread?.metadata.id === currentThreadId
      ? activeThreadSession.restoredThread
      : null;
  const threadRestorePhase = currentThreadId === null
    ? "ready" as const
    : restoredThread === null && activeThreadSession?.phase === "ready"
      ? "loading" as const
      : activeThreadSession?.phase ?? "loading";
  const currentThreadDeleted = activeThreadSession?.deleted ?? false;
  const threadRestoreError = activeThreadSession?.error ?? null;
  const profiles = useConfigurationProfiles(
    configurationLoader,
    windowState.windowState !== null,
  );
  const connection = useConfiguredServerConnection(connectionOptions);
  const serverThreads = useServerThreads(
    connection.threadClient,
    null,
    windowState.windowState?.serverId ?? null,
  );
  const conversation = useConversation({
    client: connection.conversationClient,
    currentThreadId,
    restoredThread,
    onThreadCreated: async (response) => {
      if (activeTabId === null) {
        throw new TypeError("cannot attach a thread without an active tab");
      }
      const tabId = activeTabId;
      const preparedState = startedThreadSession(response);
      setTabSessions((current) => {
        const next = new Map(current);
        next.set(tabId, {
          threadId: response.thread.id,
          state: preparedState,
          preparedClient: connection.threadClient,
        });
        return next;
      });
      try {
        await windowState.attachThread(tabId, response.thread.id);
      } catch (error) {
        setTabSessions((current) => {
          const prepared = current.get(tabId);
          if (
            prepared?.threadId !== response.thread.id ||
            prepared.state !== preparedState
          ) {
            return current;
          }
          const next = new Map(current);
          next.delete(tabId);
          return next;
        });
        try {
          void connection.threadClient
            ?.unsubscribeThread(response.thread.id)
            .result.catch(() => undefined);
        } catch {
          // 窗口状态失败后尽力释放未绑定到标签的会话订阅
        }
        throw error;
      }
    },
  });
  const resumedThreadId =
    activeThreadSession?.resumedThreadId === currentThreadId
      ? currentThreadId
      : null;
  const subscribedThreadIds = useMemo(
    () => windowTabs.flatMap(({ threadId }) =>
      threadId === null ? [] : [threadId]
    ),
    [windowTabs],
  );
  const backgroundTerminals = useBackgroundTerminals(
    connection.conversationClient,
    currentThreadId,
    resumedThreadId,
    subscribedThreadIds,
  );
  const turnPlan = useTurnPlan(
    connection.conversationClient,
    currentThreadId,
    subscribedThreadIds,
  );
  const [draftCwds, setDraftCwds] = useState<ReadonlyMap<string, string | null>>(
    () => new Map(),
  );
  const draftCwd = activeTabId === null
    ? null
    : draftCwds.get(activeTabId) ?? null;
  const setDraftCwd = useCallback((cwd: string | null) => {
    if (activeTabId === null) {
      return;
    }
    setDraftCwds((current) => {
      const next = new Map(current);
      next.set(activeTabId, cwd);
      return next;
    });
  }, [activeTabId]);
  const tabDraftStore = useMemo(
    () => createTransientDraftStore(draftStore),
    [draftStore],
  );
  const updateTabSession = useCallback((
    tabId: string,
    threadId: string,
    state: ThreadSessionState | null,
  ) => {
    setTabSessions((current) => {
      const existing = current.get(tabId);
      if (state === null) {
        if (existing?.threadId !== threadId) {
          return current;
        }
        const next = new Map(current);
        next.delete(tabId);
        return next;
      }
      if (existing?.threadId === threadId && existing.state === state) {
        return current;
      }
      const next = new Map(current);
      next.set(tabId, { threadId, state, preparedClient: null });
      return next;
    });
  }, []);
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
  const composerCwd = restoredThread?.metadata.cwd
    ?? draftCwd
    ?? recentCwds[0]
    ?? configuredCwd;
  const composerCapabilities = useComposerCapabilities(
    connection.capabilityClient,
    composerCwd,
  );
  const composerThreadSettings = restoredThread?.modelSettings ?? null;
  const composerDefaultModel = composerThreadSettings?.model
    ?? composerCapabilities.defaultModel;
  const composerDefaultEffort = composerThreadSettings === null
    ? composerCapabilities.defaultEffort
    : composerThreadSettings.effort;
  const composerDefaultServiceTier = composerThreadSettings === null
    ? composerCapabilities.defaultServiceTier
    : composerThreadSettings.serviceTier;
  const composerDefaultModelSource = composerThreadSettings !== null
    ? "thread" as const
    : composerCapabilities.defaultModel !== null || composerCapabilities.defaultEffort !== null
      ? "config" as const
      : "catalog" as const;
  const composerDefaultServiceTierSource = composerThreadSettings !== null
    ? "thread" as const
    : composerCapabilities.defaultServiceTier !== null
      ? "config" as const
      : "catalog" as const;
  const serverInteractions = useServerInteractions(connection.interactionClient);
  const accountRateLimits = useAccountRateLimits(connection.accountClient);
  const accountTokenUsage = useAccountTokenUsage(connection.accountClient);
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
  const [keyboardShortcutsOpen, setKeyboardShortcutsOpen] = useState(false);
  const [draftThreadPresence, setDraftThreadPresence] =
    useState<DraftThreadPresence>({ keyPrefix: null, threadIds: new Set() });
  const [shortcutStatus, setShortcutStatus] = useState<string | null>(null);
  const [commandLocationRequest, setCommandLocationRequest] =
    useState<CommandLocationRequest | null>(null);
  const [notificationPermission, setNotificationPermission] =
    useState<DesktopNotificationPermission>("default");
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
  const [protocolDebugEnabled, setProtocolDebugEnabled] = useState(false);
  const [
    windowReferenceSubscriptionAttempt,
    setWindowReferenceSubscriptionAttempt,
  ] = useState(0);
  const editorSequenceRef = useRef(0);
  const recordedProxyTestRef = useRef<string | null>(null);
  const draftPresenceOverridesRef = useRef<DraftPresenceOverrides>({
    keyPrefix: null,
    entries: new Map(),
  });
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

  useEffect(() => {
    let active = true;
    void protocolDebugAvailabilityLoader().then(
      (available) => {
        if (active) setProtocolDebugEnabled(available);
      },
      () => {
        if (active) setProtocolDebugEnabled(false);
      },
    );
    return () => {
      active = false;
    };
  }, [protocolDebugAvailabilityLoader]);

  const openProtocolDebugger = useCallback(() => {
    setWindowActionError(null);
    void protocolDebugWindowOpener().catch(() => {
      setWindowActionError("无法打开协议检查器，请重试");
    });
  }, [protocolDebugWindowOpener]);
  const deepLinkInFlightRef = useRef(false);
  const commandLocationSequenceRef = useRef(0);

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
  const draftKeyPrefix = composerDraftKeyPrefix(windowId, boundServerId);
  const draftThreadIds = draftThreadPresence.keyPrefix === draftKeyPrefix
    ? draftThreadPresence.threadIds
    : EMPTY_THREAD_IDS;
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
    setCommandLocationRequest(null);
  }, [currentThreadId]);

  useEffect(() => {
    let disposed = false;
    draftPresenceOverridesRef.current = {
      keyPrefix: draftKeyPrefix,
      entries: new Map(),
    };
    setDraftThreadPresence({ keyPrefix: draftKeyPrefix, threadIds: new Set() });
    if (draftKeyPrefix === null) {
      return () => { disposed = true; };
    }
    void draftStore.listKeys(draftKeyPrefix).then(
      (draftKeys) => {
        if (disposed) return;
        const threadIds = new Set<string>();
        for (const draftKey of draftKeys) {
          const threadId = draftThreadId(draftKeyPrefix, draftKey);
          if (threadId !== null) threadIds.add(threadId);
        }
        const overrides = draftPresenceOverridesRef.current;
        if (overrides.keyPrefix === draftKeyPrefix) {
          for (const [threadId, present] of overrides.entries) {
            if (present) threadIds.add(threadId);
            else threadIds.delete(threadId);
          }
        }
        setDraftThreadPresence({ keyPrefix: draftKeyPrefix, threadIds });
      },
      () => undefined,
    );
    return () => { disposed = true; };
  }, [draftKeyPrefix, draftStore]);

  const updateDraftPresence = useCallback((draftKey: string, present: boolean) => {
    if (draftKeyPrefix === null) return;
    const threadId = draftThreadId(draftKeyPrefix, draftKey);
    if (threadId === null) return;
    const overrides = draftPresenceOverridesRef.current;
    if (overrides.keyPrefix !== draftKeyPrefix) {
      draftPresenceOverridesRef.current = {
        keyPrefix: draftKeyPrefix,
        entries: new Map([[threadId, present]]),
      };
    } else {
      overrides.entries.set(threadId, present);
    }
    setDraftThreadPresence((current) => {
      const threadIds = new Set(
        current.keyPrefix === draftKeyPrefix ? current.threadIds : [],
      );
      if (present) threadIds.add(threadId);
      else threadIds.delete(threadId);
      return { keyPrefix: draftKeyPrefix, threadIds };
    });
  }, [draftKeyPrefix]);

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
    let active = true;
    void notificationService.permission().then((permission) => {
      if (active) setNotificationPermission(permission);
    });
    return () => {
      active = false;
    };
  }, [notificationService]);

  useEffect(() => {
    const threadId = currentThreadId;
    const previous = conversationActivityRef.current;
    const latestTurn = displayedRestoredThread?.turns.at(-1);
    if (
      preferences.preferences.notifyTaskComplete &&
      previous.threadId === threadId &&
      previous.activeTurnId !== null &&
      conversation.activeTurnId === null &&
      latestTurn?.status === "completed"
    ) {
      void notificationService.show({
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
    currentThreadId,
  ]);

  useEffect(() => {
    const currentKeys = new Set(serverInteractions.pending.map(({ key }) => key));
    const hasNewRequest = serverInteractions.pending.some(
      ({ key }) => !notifiedApprovalKeysRef.current.has(key),
    );
    if (hasNewRequest && preferences.preferences.notifyApproval) {
      void notificationService.show({
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
      void notificationService.show({
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

  const contentTitle =
    currentThreadDeleted
      ? "会话已删除"
      : restoredThread === null
        ? currentThreadId === null
          ? "新任务"
          : "正在恢复会话"
        : threadDisplayTitle(restoredThread.metadata);
  const contentSubtitle = restoredThread?.metadata.cwd
    ? getBasename(restoredThread.metadata.cwd)
    : boundServerName;
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
    document.title = currentThreadDeleted
      ? `会话已删除 — ${boundServerName}`
      : restoredThread === null
        ? `Codex Desktop Linux — ${boundServerName}`
        : `${threadDisplayTitle(restoredThread.metadata)} — ${boundServerName}`;
  }, [boundServerName, currentThreadDeleted, restoredThread]);

  useEffect(() => {
    if (shortcutStatus === null) return;
    const timeout = window.setTimeout(() => setShortcutStatus(null), 2_000);
    return () => window.clearTimeout(timeout);
  }, [shortcutStatus]);

  useEffect(() => {
    setDraftCwds(new Map());
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
    if (windowId === null) {
      return;
    }
    let disposed = false;
    let release: (() => void) | null = null;
    void windowStateSubscriber(windowState.applyExternalState).then(
      (unsubscribe) => {
        if (disposed) {
          unsubscribe();
        } else {
          release = unsubscribe;
        }
      },
      () => {
        if (!disposed) {
          setWindowActionError("无法同步标签状态，请重试");
        }
      },
    );
    return () => {
      disposed = true;
      release?.();
    };
  }, [windowId, windowState.applyExternalState, windowStateSubscriber]);

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
          await windowState.openTab(target.threadId);
        }
        setWindowActionError(null);
      } catch (error) {
        if (
          error instanceof WindowStateControllerError &&
          error.code === "serverAlreadyOpen"
        ) {
          try {
            await windowOpener({
              serverId: target.serverId,
              ...(target.threadId === undefined
                ? {}
                : { threadId: target.threadId }),
            });
            setWindowActionError(null);
          } catch {
            setWindowActionError("无法打开深链目标，请重试");
          }
        } else {
          setWindowActionError("无法打开深链目标，请重试");
        }
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
    const sourceTabId = activeTabId;
    const sourceWasBlank = currentThreadId === null;
    try {
      const state = await windowState.replaceActiveThread(threadId);
      if (
        sourceWasBlank &&
        sourceTabId !== null &&
        state.tabs.find(({ id }) => id === sourceTabId)?.threadId !== null
      ) {
        const key = transientDraftKey(
          state.windowId,
          state.serverId ?? null,
          sourceTabId,
        );
        if (key !== null) {
          tabDraftStore.discardTransient(key);
        }
      }
    } catch {
      setWindowActionError("无法打开会话，请重试");
    }
  };

  const openThreadInNewTab = async (threadId: string): Promise<void> => {
    if (windowState.status !== "ready") {
      return;
    }
    setWindowActionError(null);
    try {
      await windowState.openTab(threadId);
    } catch {
      setWindowActionError("无法在新标签打开会话，请重试");
    }
  };

  const openNewTask = async (
    targetCwd: string | null = restoredThread?.metadata.cwd ?? null,
  ): Promise<void> => {
    if (windowState.status !== "ready") {
      return;
    }
    setWindowActionError(null);
    const targetTabId = activeTabId;
    const sourceWasThread = currentThreadId !== null;
    const previousDraftCwd = draftCwd;
    setDraftCwd(targetCwd);
    try {
      const state = await windowState.replaceActiveThread(null);
      if (sourceWasThread && targetTabId !== null) {
        const key = transientDraftKey(
          state.windowId,
          state.serverId ?? null,
          targetTabId,
        );
        if (key !== null) {
          tabDraftStore.resetTransient(key);
        }
      }
    } catch {
      if (targetTabId === activeTabId) {
        setDraftCwd(previousDraftCwd);
      }
      setWindowActionError("无法新建任务，请重试");
    }
  };

  const openNewTab = useCallback(async (
    targetCwd: string | null = restoredThread?.metadata.cwd ?? null,
  ): Promise<void> => {
    if (windowState.status !== "ready") {
      return;
    }
    setWindowActionError(null);
    try {
      const state = await windowState.openTab();
      if (state.activeTabId !== undefined && targetCwd !== null) {
        setDraftCwds((current) => {
          const next = new Map(current);
          next.set(state.activeTabId!, targetCwd);
          return next;
        });
      }
    } catch {
      setWindowActionError("无法新建会话标签，请重试");
    }
  }, [restoredThread?.metadata.cwd, windowState]);

  const activateTab = async (tabId: string): Promise<void> => {
    if (
      windowState.status !== "ready" ||
      conversation.submitting ||
      tabId === activeTabId
    ) {
      return;
    }
    setWindowActionError(null);
    try {
      await windowState.activateTab(tabId);
    } catch {
      setWindowActionError("无法切换会话标签，请重试");
    }
  };

  const closeTab = async (tabId: string): Promise<void> => {
    if (windowState.status !== "ready" || conversation.submitting) {
      return;
    }
    const tab = windowTabs.find(({ id }) => id === tabId);
    setWindowActionError(null);
    try {
      await windowState.closeTab(tabId);
      setDraftCwds((current) => {
        if (!current.has(tabId)) {
          return current;
        }
        const next = new Map(current);
        next.delete(tabId);
        return next;
      });
      if (tab?.threadId === null) {
        const key = transientDraftKey(
          windowState.windowState?.windowId ?? null,
          boundServerId,
          tabId,
        );
        if (key !== null) {
          tabDraftStore.discardTransient(key);
        }
      }
    } catch {
      setWindowActionError("无法关闭会话标签，请重试");
    }
  };

  const openNewWindowTask = useCallback(() => {
    if (boundServerId === null) return;
    setWindowActionError(null);
    void windowOpener({ serverId: boundServerId }).then(
      () => profiles.reload(),
      () => setWindowActionError("无法打开服务器窗口，请重试"),
    );
  }, [boundServerId, profiles.reload, windowOpener]);

  useEffect(() => {
    const handleGlobalShortcut = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        const blockingLayer = document.querySelector(
          '[aria-modal="true"], [role="dialog"], [role="menu"], [role="listbox"], [aria-label="会话侧栏"][data-open="true"]',
        );
        if (
          !event.defaultPrevented &&
          blockingLayer === null &&
          conversation.activeTurnId !== null &&
          !conversation.stopping
        ) {
          event.preventDefault();
          void conversation.stop();
        }
        return;
      }
      if (!event.ctrlKey || event.altKey || event.metaKey) return;
      const key = event.key.toLowerCase();
      const editing = event.target instanceof HTMLElement && (
        event.target.matches("input, textarea, select") || event.target.isContentEditable
      );
      if (
        key === "tab" &&
        activeTabId !== null &&
        !conversation.submitting
      ) {
        event.preventDefault();
        const target = adjacentTabId(
          windowTabs,
          activeTabId,
          event.shiftKey ? -1 : 1,
        );
        if (target !== null) {
          void windowState.activateTab(target);
        }
      } else if (
        (event.key === "PageUp" || event.key === "PageDown") &&
        activeTabId !== null &&
        !conversation.submitting
      ) {
        event.preventDefault();
        const target = adjacentTabId(
          windowTabs,
          activeTabId,
          event.key === "PageDown" ? 1 : -1,
        );
        if (target !== null) {
          void windowState.activateTab(target);
        }
      } else if (
        !event.shiftKey &&
        /^[1-9]$/u.test(key) &&
        windowTabs.length > 0 &&
        !conversation.submitting
      ) {
        event.preventDefault();
        const index = key === "9"
          ? windowTabs.length - 1
          : Math.min(Number(key) - 1, windowTabs.length - 1);
        const target = windowTabs[index];
        if (target !== undefined) {
          void windowState.activateTab(target.id);
        }
      } else if (
        (key === "n" || key === "t") &&
        !event.shiftKey &&
        !conversation.submitting
      ) {
        event.preventDefault();
        void openNewTab();
      } else if (
        (key === "w" || event.key === "F4") &&
        !event.shiftKey &&
        activeTabId !== null &&
        !conversation.submitting
      ) {
        event.preventDefault();
        void closeTab(activeTabId);
      } else if ((key === "/" && !event.shiftKey) || event.code === "Slash") {
        event.preventDefault();
        setKeyboardShortcutsOpen(true);
      } else if (key === ",") {
        event.preventDefault();
        setSettingsSection("appearance");
      } else if (key === "d" && event.shiftKey && protocolDebugEnabled) {
        event.preventDefault();
        openProtocolDebugger();
      } else if (key === "l") {
        const composer = document.querySelector<HTMLTextAreaElement>("[data-composer-input]");
        if (composer !== null && !composer.disabled) {
          event.preventDefault();
          composer.focus();
        }
      } else if (
        key === "n" &&
        event.shiftKey &&
        boundServerId !== null &&
        !conversation.submitting
      ) {
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
  }, [
    boundServerId,
    activeTabId,
    conversation.activeTurnId,
    conversation.submitting,
    conversation.stop,
    conversation.stopping,
    displayedRestoredThread,
    closeTab,
    openNewTab,
    openNewWindowTask,
    openProtocolDebugger,
    protocolDebugEnabled,
    windowState,
    windowTabs,
  ]);

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
    if (notificationPermission === "unsupported") {
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
    const tab = windowState.windowState?.tabs.find(
      (candidate) => candidate.threadId === threadId,
    );
    if (windowState.status === "ready" && tab !== undefined) {
      try {
        await windowState.closeTab(tab.id);
      } catch {
        setWindowActionError("会话已删除，但无法更新当前窗口状态");
      }
    }
  };

  const archiveThread = async (threadId: string): Promise<void> => {
    const archived = await serverThreads.archiveThread(threadId);
    if (!archived) {
      return;
    }
    const tab = windowState.windowState?.tabs.find(
      (candidate) => candidate.threadId === threadId,
    );
    if (windowState.status === "ready" && tab !== undefined) {
      try {
        await windowState.closeTab(tab.id);
      } catch {
        setWindowActionError("会话已归档，但无法关闭对应标签");
      }
    }
  };

  const forkThread = async (turnId: string): Promise<void> => {
    const threadId = currentThreadId;
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
      await windowState.openTab(response.thread.id);
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
    } catch (error) {
      if (
        error instanceof WindowStateControllerError &&
        error.code === "serverAlreadyOpen"
      ) {
        return "cancelled";
      }
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

  const activePendingInteractions = currentThreadId === null
    ? []
    : serverInteractions.pending.filter(
        ({ threadId }) => threadId === currentThreadId,
      );
  const tabViews = useMemo<readonly ThreadTabView[]>(
    () => windowTabs.map((tab) => {
      const thread = tab.threadId === null
        ? undefined
        : serverThreads.threads.find(({ id }) => id === tab.threadId);
      const cwd = thread?.cwd ||
        (tab.threadId === null
          ? draftCwds.get(tab.id) ?? recentCwds[0] ?? configuredCwd
          : null);
      const waiting = tab.threadId === null
        ? undefined
        : serverInteractions.pending.find(
            ({ threadId }) => threadId === tab.threadId,
          );
      return {
        id: tab.id,
        projectName: cwd ? getBasename(cwd) : boundServerName,
        ...(cwd ? { projectPath: cwd } : {}),
        title: tab.threadId === null
          ? "新任务"
          : thread === undefined
            ? "正在恢复会话"
            : threadDisplayTitle(thread),
        ...(waiting === undefined
          ? threadTabStatus(thread)
          : { status: "approval" as const }),
      };
    }),
    [
      boundServerName,
      configuredCwd,
      draftCwds,
      recentCwds,
      serverInteractions.pending,
      serverThreads.threads,
      windowTabs,
    ],
  );
  const tabControlsDisabled =
    windowState.status !== "ready" || conversation.submitting;

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
      {windowTabs.map((tab) => {
        if (tab.threadId === null) {
          return null;
        }
        const prepared = tabSessions.get(tab.id);
        return (
          <ThreadSubscription
            client={connection.threadClient}
            key={tab.id}
            onChange={updateTabSession}
            preparedState={
              prepared?.preparedClient === connection.threadClient &&
                prepared.threadId === tab.threadId
                ? prepared.state
                : null
            }
            tabId={tab.id}
            threadId={tab.threadId}
          />
        );
      })}
      <WindowResizeHandles />
      <ConnectionShell
        announcement={shortcutStatus}
        archivedThread={serverThreads.archivedThread}
        backgroundCommandCounts={backgroundTerminals.counts}
        contentSubtitle={contentSubtitle}
        contentTitle={contentTitle}
        currentThreadId={currentThreadId}
        draftThreadIds={draftThreadIds}
        hasMoreThreads={serverThreads.nextThreadCursor !== null}
        loadingMoreThreads={serverThreads.loadingMoreThreads}
        mainContent={
          <ConversationWorkspace
            composer={
              connection.view.phase === "ready" && (
                restoredThread !== null ||
                currentThreadId === null
              ) ? (
                <Composer
                  activeTurn={conversation.activeTurnId !== null}
                  capabilitiesError={composerCapabilities.error}
                  canRunImmediateCommands={
                    currentThreadId !== null
                  }
                  cwd={composerCwd}
                  draftKey={composerDraftKey(
                    windowState.windowState?.windowId ?? null,
                    boundServerId,
                    activeTabId,
                    currentThreadId,
                  )}
                  draftStore={tabDraftStore}
                  error={conversation.error}
                  accessoryPanel={
                    <>
                      <TaskPlanPanel plan={turnPlan} />
                      <BackgroundCommandPanel
                        error={backgroundTerminals.error}
                        loaded={backgroundTerminals.loaded}
                        onLocate={(itemId) => {
                          commandLocationSequenceRef.current += 1;
                          setCommandLocationRequest({
                            itemId,
                            requestId: commandLocationSequenceRef.current,
                          });
                        }}
                        onTerminate={(processId) => {
                          void backgroundTerminals.terminate(processId);
                        }}
                        onTerminateAll={async (processIds) => {
                          await Promise.all(processIds.map((processId) =>
                            backgroundTerminals.terminate(processId)
                          ));
                        }}
                        terminals={backgroundTerminals.currentTerminals}
                        terminatingProcessIds={
                          backgroundTerminals.terminatingProcessIds
                        }
                        turns={displayedRestoredThread?.turns ?? []}
                      />
                    </>
                  }
                  interactionPanel={
                    <ApprovalPanel
                      onOpenLink={openContentLink}
                      onRespond={serverInteractions.respond}
                      pending={activePendingInteractions}
                      resolvedElsewhereCount={serverInteractions.resolvedElsewhereCount}
                    />
                  }
                  models={composerCapabilities.models}
                  modelsLoading={
                    composerCapabilities.modelsLoading || (
                      composerThreadSettings === null && composerCapabilities.defaultsLoading
                    )
                  }
                  defaultModel={composerDefaultModel}
                  defaultEffort={composerDefaultEffort}
                  defaultModelSource={composerDefaultModelSource}
                  defaultServiceTier={composerDefaultServiceTier}
                  defaultServiceTierSource={composerDefaultServiceTierSource}
                  defaultPermission={composerCapabilities.defaultPermission}
                  mentionReferences={composerCapabilities.mentionReferences}
                  mentionsError={composerCapabilities.mentionsError}
                  mentionsLoading={composerCapabilities.mentionsLoading}
                  onLoadMentions={composerCapabilities.loadMentions}
                  onLoadSkills={composerCapabilities.loadSkills}
                  onCwdChange={setDraftCwd}
                  onDraftPresenceChange={updateDraftPresence}
                  {...(boundServer?.configuration.type === "localStdio"
                    ? { onPickCwd: pickLocalDirectory }
                    : {})}
                  onRunImmediateCommand={conversation.runImmediateCommand}
                  onOpenSettings={() => setSettingsSection("appearance")}
                  onSearchFiles={composerCapabilities.searchFiles}
                  onServiceTierChange={conversation.setServiceTier}
                  onSend={conversation.sendInput}
                  onStop={conversation.stop}
                  permissions={composerCapabilities.permissions}
                  permissionsLoading={composerCapabilities.permissionsLoading}
                  recentCwds={recentCwds}
                  skills={composerCapabilities.skills}
                  skillsLoading={composerCapabilities.skillsLoading}
                  showProjectPicker={currentThreadId === null}
                  stopping={conversation.stopping}
                  submitting={conversation.submitting}
                />
              ) : null
            }
          >
            {displayedRestoredThread !== null ? (
              <ConversationView
                actionError={
                  forkError ?? contentError ?? threadRestoreError
                }
                commandLocationRequest={commandLocationRequest}
                onOpenDiff={openDiff}
                onOpenLink={openContentLink}
                onOpenImage={(url, name) => {
                  setContentError(null);
                  setPreviewRequest({ dataUrl: url, name, type: "dataImage" });
                }}
                {...(serverThreads.offline || activeThreadSession?.offline
                  ? {}
                  : { onForkTurn: (turnId: string, isLatest: boolean) => {
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
                  currentThreadDeleted
                    ? "deleted"
                    : currentThreadId === null
                      ? "blank"
                      : threadRestorePhase === "error"
                        ? "error"
                        : "loading"
                }
                onNewTask={() => void openNewTask()}
              />
            )}
          </ConversationWorkspace>
        }
        onArchiveThread={(threadId) => void archiveThread(threadId)}
        onDeleteThread={setDeletingThreadId}
        onLoadMoreThreads={() => void serverThreads.loadMoreThreads()}
        onLoadProjectThreads={serverThreads.loadProjectThreads}
        onNewTask={() => void openNewTab()}
        onNewTaskInProject={(cwd) => void openNewTab(cwd)}
        onRefreshThreads={() => void serverThreads.refreshThreads()}
        onSearchThreads={() => setQuickSwitcherOpen(true)}
        onOpenThread={(threadId) => void openThreadInNewTab(threadId)}
        onOpenThreadInNewTab={(threadId) => void openThreadInNewTab(threadId)}
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
        threadListError={serverThreads.threadListError}
        threadListPhase={serverThreads.threadListPhase}
        threads={serverThreads.threads}
        topbarNavigation={
          boundServerId === null ? null : (
            <ThreadTabs
              activeTabId={activeTabId}
              disabled={tabControlsDisabled}
              onActivate={(tabId) => void activateTab(tabId)}
              onClose={(tabId) => void closeTab(tabId)}
              onNew={() => void openNewTab()}
              tabs={tabViews}
            />
          )
        }
        topbarAccessory={
          <RateLimitIndicator
            data={accountRateLimits.data}
            error={accountRateLimits.error}
            loading={accountRateLimits.loading}
            onRefresh={accountRateLimits.refresh}
            refreshing={accountRateLimits.refreshing}
            updatedAt={accountRateLimits.updatedAt}
            onConsumeResetCredit={accountRateLimits.consumeResetCredit}
            resetting={accountRateLimits.resetting}
            tokenUsageData={accountTokenUsage.data}
            tokenUsageError={accountTokenUsage.error}
            tokenUsageLoading={accountTokenUsage.loading}
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
          deletingThreadId !== null &&
          serverThreads.threadListError === "无法删除会话"
            ? serverThreads.threadListError
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
        onOpenProtocolDebug={() => {
          setSettingsSection(null);
          openProtocolDebugger();
        }}
        onUpdatePreferences={updatePreferences}
        notificationPermission={notificationPermission}
        open={settingsSection !== null}
        permissionProfiles={composerCapabilities.permissions}
        preferences={preferences.preferences}
        preferencesError={preferences.error}
        preferencesLoading={preferences.loading}
        preferencesSaving={preferences.saving}
        preferencesStore={preferences.store}
        protocolDebugAvailable={protocolDebugEnabled}
        proxies={proxies}
        recentConnectionError={recentConnectionError}
        servers={servers}
        serverConnectionViews={serverConnectionViews}
      />

      <ThreadQuickSwitcher
        currentThreadId={currentThreadId}
        onClose={() => setQuickSwitcherOpen(false)}
        onOpenThread={(threadId) => void openThread(threadId)}
        open={quickSwitcherOpen}
        threads={serverThreads.threads}
      />

      <KeyboardShortcutsDialog
        onClose={() => setKeyboardShortcutsOpen(false)}
        open={keyboardShortcutsOpen}
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
  tabId: string | null,
  threadId: string | null,
): string | null {
  if (threadId === null) {
    return transientDraftKey(windowId, serverId, tabId);
  }
  const keyPrefix = composerDraftKeyPrefix(windowId, serverId);
  return keyPrefix === null
    ? null
    : `${keyPrefix}${threadId}`;
}

function transientDraftKey(
  windowId: string | null,
  serverId: string | null,
  tabId: string | null,
): string | null {
  return windowId === null || serverId === null || tabId === null
    ? null
    : `transient:${windowId}:${serverId}:${tabId}`;
}

const EMPTY_THREAD_IDS: ReadonlySet<string> = new Set();
const EMPTY_WINDOW_TABS: readonly WindowTab[] = Object.freeze([]);

function composerDraftKeyPrefix(
  windowId: string | null,
  serverId: string | null,
): string | null {
  return windowId === null || serverId === null
    ? null
    : `${windowId}:${serverId}:`;
}

function draftThreadId(keyPrefix: string, draftKey: string): string | null {
  if (!draftKey.startsWith(keyPrefix) || draftKey.length === keyPrefix.length) {
    return null;
  }
  return draftKey.slice(keyPrefix.length);
}

function getBasename(path: string): string {
  const trimmed = path.trim().replace(/[/\\]+$/, "");
  if (!trimmed) {
    return path;
  }
  const index = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  if (index === -1) {
    return trimmed;
  }
  return trimmed.slice(index + 1);
}

interface TabThreadSession {
  readonly threadId: string;
  readonly state: ThreadSessionState;
  readonly preparedClient: ServerThreadsClient | null;
}

function ThreadSubscription({
  client,
  onChange,
  preparedState,
  tabId,
  threadId,
}: {
  readonly client: ServerThreadsClient | null;
  readonly onChange: (
    tabId: string,
    threadId: string,
    state: ThreadSessionState | null,
  ) => void;
  readonly preparedState: ThreadSessionState | null;
  readonly tabId: string;
  readonly threadId: string;
}) {
  const session = useThreadSession(client, threadId, preparedState);

  useEffect(() => {
    onChange(tabId, threadId, session);
  }, [onChange, session, tabId, threadId]);

  useEffect(() => () => {
    onChange(tabId, threadId, null);
  }, [onChange, tabId, threadId]);

  return null;
}

function startedThreadSession(
  response: ThreadStartResponse,
): ThreadSessionState {
  return Object.freeze({
    phase: "ready",
    restoredThread: Object.freeze({
      metadata: response.thread,
      modelSettings: Object.freeze({
        effort: response.reasoningEffort ?? null,
        model: response.model,
        serviceTier: response.serviceTier ?? null,
      }),
      turns: Object.freeze([]),
    }),
    resumedThreadId: response.thread.id,
    deleted: false,
    offline: false,
    error: null,
  });
}

function adjacentTabId(
  tabs: readonly WindowTab[],
  activeTabId: string,
  direction: 1 | -1,
): string | null {
  if (tabs.length < 2) {
    return null;
  }
  const activeIndex = tabs.findIndex(({ id }) => id === activeTabId);
  const index = activeIndex < 0
    ? direction === 1 ? 0 : tabs.length - 1
    : (activeIndex + direction + tabs.length) % tabs.length;
  return tabs[index]?.id ?? null;
}

function threadTabStatus(
  thread: ThreadSummary | undefined,
): Pick<ThreadTabView, "status"> {
  if (thread?.status.type === "systemError") {
    return { status: "error" };
  }
  if (thread?.status.type !== "active") {
    return {};
  }
  if (thread.status.activeFlags.includes("waitingOnApproval")) {
    return { status: "approval" };
  }
  if (thread.status.activeFlags.includes("waitingOnUserInput")) {
    return { status: "input" };
  }
  return { status: "running" };
}
