import { useCallback, useEffect, useId, useRef, useState } from "react";

import type { ServerId, ServerProfile } from "../configuration";
import type { ConnectionPhase } from "../store/connectionSlice";
import styles from "./ServerSwitcher.module.css";

export interface ServerSwitcherProps {
  readonly servers: readonly ServerProfile[];
  readonly currentServerId: ServerId | null;
  readonly highRiskServerIds: ReadonlySet<ServerId>;
  readonly serverConnectionViews: Readonly<
    Record<string, ServerConnectionView | undefined>
  >;
  readonly isLoading: boolean;
  readonly configurationErrorSummary: string | null;
  readonly configurationWarningSummary: string | null;
  readonly onReloadConfiguration?: () => void;
  readonly onConnect: (
    serverId: ServerId,
  ) => ServerConnectionStartResult | Promise<ServerConnectionStartResult>;
  readonly onCreate: () => void;
  readonly onDelete?: (serverId: ServerId) => void;
  readonly onEdit: (serverId: ServerId) => void;
  readonly onOpenDiagnostics?: (serverId: ServerId) => void;
  readonly onOpenInNewWindow?: (serverId: ServerId) => void;
}

export type ServerConnectionPhase = ConnectionPhase | "reconnecting";

export interface ServerConnectionView {
  readonly phase: ServerConnectionPhase;
  readonly errorSummary: string | null;
}

export type ServerConnectionStartResult = "started" | "cancelled";

interface StartedConnection {
  readonly serverId: ServerId;
  readonly initialServerId: ServerId | null;
  readonly initialPhase: ServerConnectionPhase;
  readonly requestVersion: number;
  readonly startConfirmed: boolean;
  readonly hasTransitioned: boolean;
}

const DISCONNECTED_VIEW = Object.freeze({
  phase: "disconnected",
  errorSummary: null,
}) satisfies ServerConnectionView;

const PHASE_LABELS: Readonly<Record<ServerConnectionPhase, string>> = {
  disconnected: "未连接",
  connecting: "连接中",
  initializing: "初始化中",
  ready: "已连接",
  reconnecting: "重连中",
  error: "连接错误",
};

function ServerTypeIcon({ type }: { type: "localStdio" | "remoteWebSocket" }) {
  if (type === "localStdio") {
    return (
      <span className={styles.typeIcon}>
        <svg aria-hidden="true" viewBox="0 0 24 24">
          <rect height="16" rx="3" width="18" x="3" y="4" />
          <path d="m7 9 3 3-3 3M12.5 15H17" />
        </svg>
        <span className={styles.visuallyHidden}>本机 stdio</span>
      </span>
    );
  }

  return (
    <span className={styles.typeIcon}>
      <svg aria-hidden="true" viewBox="0 0 24 24">
        <circle cx="12" cy="12" r="8" />
        <path d="M4 12h16M12 4a13 13 0 0 1 0 16M12 4a13 13 0 0 0 0 16" />
      </svg>
      <span className={styles.visuallyHidden}>远程 WebSocket</span>
    </span>
  );
}

function ServerIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24">
      <rect height="6" rx="2" width="16" x="4" y="4" />
      <rect height="6" rx="2" width="16" x="4" y="14" />
      <path d="M8 7h.01M8 17h.01" />
    </svg>
  );
}

function AddIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24">
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

function ExpandIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24">
      <path d="m7 9 5 5 5-5" />
    </svg>
  );
}

function MoreIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24">
      <circle cx="5" cy="12" r="1" />
      <circle cx="12" cy="12" r="1" />
      <circle cx="19" cy="12" r="1" />
    </svg>
  );
}

function getServerSummary(server: ServerProfile): string {
  const { configuration } = server;
  if (configuration.type === "remoteWebSocket") {
    return configuration.url;
  }

  return [configuration.executablePath, ...configuration.arguments].join(" ");
}

export function ServerSwitcher({
  servers,
  currentServerId,
  highRiskServerIds,
  serverConnectionViews,
  isLoading,
  configurationErrorSummary,
  configurationWarningSummary,
  onReloadConfiguration,
  onConnect,
  onCreate,
  onDelete,
  onEdit,
  onOpenDiagnostics,
  onOpenInNewWindow,
}: ServerSwitcherProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [openMenuServerId, setOpenMenuServerId] = useState<ServerId | null>(
    null,
  );
  const [connectionRequestServerId, setConnectionRequestServerId] =
    useState<ServerId | null>(null);
  const [startedConnection, setStartedConnection] =
    useState<StartedConnection | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLElement>(null);
  const createButtonRef = useRef<HTMLButtonElement>(null);
  const configurationRetryButtonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuButtonRefs = useRef(new Map<ServerId, HTMLButtonElement>());
  const menuInitialFocusRef = useRef<"first" | "last">("first");
  const connectionRequestVersionRef = useRef(0);
  const panelId = useId();
  const titleId = useId();
  const currentServer = servers.find(
    ({ serverId }) => serverId === currentServerId,
  );
  const currentName = currentServer?.name ?? "选择服务器";
  const currentConnectionView = currentServer
    ? (serverConnectionViews[currentServer.serverId] ?? DISCONNECTED_VIEW)
    : DISCONNECTED_VIEW;
  const currentPhase = currentServer
    ? currentConnectionView.phase
    : configurationErrorSummary
      ? "error"
      : "disconnected";
  const currentHighRisk =
    currentServer !== undefined &&
    highRiskServerIds.has(currentServer.serverId);
  const baseCurrentStatus =
    isLoading && !currentServer ? "加载中" : PHASE_LABELS[currentPhase];
  const currentStatus = currentHighRisk
    ? `高风险 TLS · ${baseCurrentStatus}`
    : baseCurrentStatus;
  const configurationLocked = isLoading || configurationErrorSummary !== null;
  const configurationBannerSummary =
    configurationErrorSummary ?? configurationWarningSummary;

  const closeAndRestoreFocus = useCallback(() => {
    setOpenMenuServerId(null);
    setIsOpen(false);
    triggerRef.current?.focus();
  }, []);

  const closeWithoutRestoringFocus = useCallback(() => {
    setOpenMenuServerId(null);
    setIsOpen(false);
  }, []);

  useEffect(() => {
    if (configurationLocked) {
      setOpenMenuServerId(null);
    }
  }, [configurationLocked]);

  useEffect(() => {
    if (!startedConnection) {
      return;
    }

    if (
      !servers.some(({ serverId }) => serverId === startedConnection.serverId)
    ) {
      setStartedConnection(null);
      return;
    }

    const connectionView =
      serverConnectionViews[startedConnection.serverId] ?? DISCONNECTED_VIEW;
    const phaseChanged =
      startedConnection.initialPhase !== connectionView.phase;
    const stateChanged =
      startedConnection.initialServerId !== currentServerId || phaseChanged;
    const hasTransitioned = startedConnection.hasTransitioned || stateChanged;
    if (!startedConnection.startConfirmed) {
      if (hasTransitioned && !startedConnection.hasTransitioned) {
        setStartedConnection({ ...startedConnection, hasTransitioned: true });
      }
      return;
    }

    if (
      connectionView.phase === "ready" &&
      currentServerId === startedConnection.serverId
    ) {
      setStartedConnection(null);
      if (isOpen) {
        closeAndRestoreFocus();
      }
    } else if (connectionView.phase === "error" && hasTransitioned) {
      setStartedConnection(null);
    } else if (!startedConnection.hasTransitioned && stateChanged) {
      setStartedConnection({ ...startedConnection, hasTransitioned: true });
    }
  }, [
    closeAndRestoreFocus,
    currentServerId,
    isOpen,
    serverConnectionViews,
    servers,
    startedConnection,
  ]);

  useEffect(
    () => () => {
      connectionRequestVersionRef.current += 1;
    },
    [],
  );

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    if (
      configurationBannerSummary !== null &&
      configurationRetryButtonRef.current !== null
    ) {
      configurationRetryButtonRef.current.focus();
    } else if (!configurationLocked) {
      createButtonRef.current?.focus();
    } else {
      panelRef.current?.focus();
    }

    const handleClickOutside = (event: MouseEvent) => {
      if (
        event.target instanceof Node &&
        !rootRef.current?.contains(event.target)
      ) {
        closeWithoutRestoringFocus();
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") {
        return;
      }

      event.preventDefault();
      closeAndRestoreFocus();
    };

    document.addEventListener("click", handleClickOutside);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("click", handleClickOutside);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [
    closeAndRestoreFocus,
    closeWithoutRestoringFocus,
    configurationBannerSummary,
    configurationLocked,
    isOpen,
  ]);

  useEffect(() => {
    if (!openMenuServerId) {
      return;
    }

    const menuItems = Array.from(
      menuRef.current?.querySelectorAll<HTMLButtonElement>(
        '[role="menuitem"]',
      ) ?? [],
    );
    const initialItem =
      menuInitialFocusRef.current === "last"
        ? menuItems.at(-1)
        : menuItems.at(0);
    initialItem?.focus();

    const menuButton = menuButtonRefs.current.get(openMenuServerId);
    const handleClickOutsideMenu = (event: MouseEvent) => {
      if (!(event.target instanceof Node)) {
        return;
      }

      const targetElement =
        event.target instanceof Element ? event.target : null;
      if (
        !menuRef.current?.contains(event.target) &&
        !menuButton?.contains(event.target) &&
        !targetElement?.closest('[data-server-menu-trigger="true"]')
      ) {
        setOpenMenuServerId(null);
      }
    };
    const handleFocusOutsideMenu = (event: FocusEvent) => {
      if (
        event.target instanceof Node &&
        !menuRef.current?.contains(event.target) &&
        !menuButton?.contains(event.target)
      ) {
        setOpenMenuServerId(null);
      }
    };

    document.addEventListener("click", handleClickOutsideMenu);
    document.addEventListener("focusin", handleFocusOutsideMenu);
    return () => {
      document.removeEventListener("click", handleClickOutsideMenu);
      document.removeEventListener("focusin", handleFocusOutsideMenu);
    };
  }, [openMenuServerId]);

  const closeForAction = (action: () => void) => {
    triggerRef.current?.focus();
    setOpenMenuServerId(null);
    setIsOpen(false);
    action();
  };

  const openServerMenu = (
    serverId: ServerId,
    initialFocus: "first" | "last" = "first",
  ) => {
    menuInitialFocusRef.current = initialFocus;
    setOpenMenuServerId(serverId);
  };

  const requestConnection = (
    serverId: ServerId,
    initialPhase: ServerConnectionPhase,
  ) => {
    if (configurationLocked || connectionRequestServerId !== null) {
      return;
    }

    const requestVersion = connectionRequestVersionRef.current + 1;
    connectionRequestVersionRef.current = requestVersion;
    setConnectionRequestServerId(serverId);
    setStartedConnection({
      serverId,
      initialServerId: currentServerId,
      initialPhase,
      requestVersion,
      startConfirmed: false,
      hasTransitioned: false,
    });
    setOpenMenuServerId(null);

    let result:
      ServerConnectionStartResult | Promise<ServerConnectionStartResult>;
    try {
      result = onConnect(serverId);
    } catch {
      setConnectionRequestServerId(null);
      setStartedConnection(null);
      return;
    }

    void Promise.resolve(result).then(
      (startResult) => {
        if (connectionRequestVersionRef.current !== requestVersion) {
          return;
        }
        setConnectionRequestServerId(null);
        if (startResult === "started") {
          setStartedConnection((connection) =>
            connection?.requestVersion === requestVersion
              ? { ...connection, startConfirmed: true }
              : connection,
          );
        } else {
          setStartedConnection(null);
        }
      },
      () => {
        if (connectionRequestVersionRef.current === requestVersion) {
          setConnectionRequestServerId(null);
          setStartedConnection(null);
        }
      },
    );
  };

  const handleMenuKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const menuItems = Array.from(
      event.currentTarget.querySelectorAll<HTMLButtonElement>(
        '[role="menuitem"]',
      ),
    );
    const currentIndex = menuItems.indexOf(
      document.activeElement as HTMLButtonElement,
    );
    let nextIndex: number | null = null;

    if (event.key === "ArrowDown") {
      nextIndex = (currentIndex + 1) % menuItems.length;
    } else if (event.key === "ArrowUp") {
      nextIndex = (currentIndex - 1 + menuItems.length) % menuItems.length;
    } else if (event.key === "Home") {
      nextIndex = 0;
    } else if (event.key === "End") {
      nextIndex = menuItems.length - 1;
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      const menuServerId = openMenuServerId;
      setOpenMenuServerId(null);
      if (menuServerId) {
        menuButtonRefs.current.get(menuServerId)?.focus();
      }
      return;
    } else if (event.key === "Tab") {
      event.preventDefault();
      event.stopPropagation();
      const menuServerId = openMenuServerId;
      const menuButton = menuServerId
        ? menuButtonRefs.current.get(menuServerId)
        : undefined;
      setOpenMenuServerId(null);
      if (event.shiftKey) {
        menuButton?.focus();
        return;
      }

      const focusableOutsideMenu = Array.from(
        rootRef.current?.querySelectorAll<HTMLButtonElement>(
          "button:not(:disabled)",
        ) ?? [],
      ).filter((button) => !event.currentTarget.contains(button));
      const menuButtonIndex = menuButton
        ? focusableOutsideMenu.indexOf(menuButton)
        : -1;
      (
        focusableOutsideMenu[menuButtonIndex + 1] ?? triggerRef.current
      )?.focus();
      return;
    }

    if (nextIndex !== null) {
      event.preventDefault();
      menuItems[nextIndex]?.focus();
    }
  };

  return (
    <div className={styles.root} ref={rootRef}>
      {isOpen ? (
        <section
          aria-busy={isLoading || undefined}
          aria-labelledby={titleId}
          className={styles.panel}
          id={panelId}
          ref={panelRef}
          role="dialog"
          tabIndex={-1}
        >
          <header className={styles.panelHeader}>
            <h2 id={titleId}>服务器</h2>
            <button
              className={styles.createButton}
              disabled={configurationLocked}
              onClick={() => closeForAction(onCreate)}
              ref={createButtonRef}
              type="button"
            >
              <AddIcon />
              <span>新建服务器</span>
            </button>
          </header>

          {configurationBannerSummary ? (
            <div
              className={styles.configurationBanner}
              data-severity={configurationErrorSummary === null ? "warning" : "error"}
              role="alert"
            >
              <span>{configurationBannerSummary}</span>
              {onReloadConfiguration ? (
                <button
                  className={styles.configurationRetryButton}
                  onClick={onReloadConfiguration}
                  ref={configurationRetryButtonRef}
                  type="button"
                >
                  重新加载
                </button>
              ) : null}
            </div>
          ) : null}

          {isLoading ? (
            <div className={styles.loadingStatus} role="status">
              <span aria-hidden="true" className={styles.loadingIndicator} />
              <span>正在加载服务器</span>
            </div>
          ) : null}

          {servers.length > 0 ? (
            <ul aria-label="已保存服务器" className={styles.serverList}>
              {servers.map((server) => {
                const isCurrent = server.serverId === currentServerId;
                const isHighRisk = highRiskServerIds.has(server.serverId);
                const connectionView =
                  serverConnectionViews[server.serverId] ?? DISCONNECTED_VIEW;
                const serverPhase = connectionView.phase;
                const isConnecting =
                  serverPhase === "connecting" ||
                  serverPhase === "initializing" ||
                  serverPhase === "reconnecting";
                const isConnected = isCurrent && serverPhase === "ready";
                const isRequesting =
                  server.serverId === connectionRequestServerId;
                const connectLabel = isRequesting
                  ? "处理中"
                  : isConnecting
                    ? PHASE_LABELS[serverPhase]
                    : isConnected
                      ? "已连接"
                      : serverPhase === "ready"
                        ? "切换"
                        : "连接";
                const summary = getServerSummary(server);
                const errorSummary =
                  serverPhase === "error" ? connectionView.errorSummary : null;

                return (
                  <li
                    aria-current={isCurrent || undefined}
                    className={styles.serverRow}
                    data-current={isCurrent}
                    key={server.serverId}
                  >
                    <div className={styles.serverDetails}>
                      <ServerTypeIcon type={server.configuration.type} />
                      <span className={styles.serverIdentity}>
                        <strong>{server.name}</strong>
                        <span className={styles.serverSummary} title={summary}>
                          {summary}
                        </span>
                      </span>
                      <span
                        className={styles.rowStatus}
                        data-phase={serverPhase}
                      >
                        <span aria-hidden="true" className={styles.statusDot} />
                        <span>{PHASE_LABELS[serverPhase]}</span>
                      </span>
                    </div>

                    {isHighRisk ? (
                      <div
                        className={styles.rowSecurityWarning}
                        title="此连接允许无效 TLS 证书"
                      >
                        高风险 TLS：允许无效证书
                      </div>
                    ) : null}

                    {errorSummary ? (
                      <div className={styles.rowError}>
                        <span>{errorSummary}</span>
                        {onOpenDiagnostics ? (
                          <button
                            aria-label={`查看 ${server.name} 诊断`}
                            className={styles.diagnosticsButton}
                            onClick={() =>
                              closeForAction(() =>
                                onOpenDiagnostics(server.serverId),
                              )
                            }
                            type="button"
                          >
                            查看诊断
                          </button>
                        ) : null}
                      </div>
                    ) : null}

                    <div
                      aria-label={`${server.name} 操作`}
                      className={styles.actions}
                      role="group"
                    >
                      <button
                        aria-label={`${connectLabel} ${server.name}`}
                        className={styles.connectButton}
                        disabled={
                          connectionRequestServerId !== null ||
                          configurationLocked ||
                          isConnecting ||
                          isConnected
                        }
                        onClick={() =>
                          requestConnection(server.serverId, serverPhase)
                        }
                        type="button"
                      >
                        {isRequesting || isConnecting ? (
                          <span
                            aria-hidden="true"
                            className={styles.loadingIndicator}
                          />
                        ) : null}
                        <span>{connectLabel}</span>
                      </button>
                      {onOpenInNewWindow && serverPhase !== "ready" ? (
                        <button
                          aria-label={`在新窗口打开 ${server.name}`}
                          className={styles.actionButton}
                          disabled={configurationLocked}
                          onClick={() =>
                            closeForAction(() =>
                              onOpenInNewWindow(server.serverId),
                            )
                          }
                          type="button"
                        >
                          新窗口
                        </button>
                      ) : null}
                      <div className={styles.menuContainer}>
                        <button
                          aria-controls={`${panelId}-menu-${server.serverId}`}
                          aria-expanded={openMenuServerId === server.serverId}
                          aria-haspopup="menu"
                          aria-label={`管理 ${server.name}`}
                          className={styles.menuButton}
                          data-server-menu-trigger="true"
                          disabled={configurationLocked}
                          onClick={() => {
                            if (openMenuServerId === server.serverId) {
                              setOpenMenuServerId(null);
                            } else {
                              openServerMenu(server.serverId);
                            }
                          }}
                          onKeyDown={(event) => {
                            if (
                              event.key !== "ArrowDown" &&
                              event.key !== "ArrowUp"
                            ) {
                              return;
                            }

                            event.preventDefault();
                            openServerMenu(
                              server.serverId,
                              event.key === "ArrowUp" ? "last" : "first",
                            );
                          }}
                          ref={(element) => {
                            if (element) {
                              menuButtonRefs.current.set(
                                server.serverId,
                                element,
                              );
                            } else {
                              menuButtonRefs.current.delete(server.serverId);
                            }
                          }}
                          title={`管理 ${server.name}`}
                          type="button"
                        >
                          <MoreIcon />
                        </button>
                      </div>
                    </div>

                    {openMenuServerId === server.serverId ? (
                      <div
                        aria-label={`${server.name} 管理菜单`}
                        className={styles.menu}
                        id={`${panelId}-menu-${server.serverId}`}
                        onKeyDown={handleMenuKeyDown}
                        ref={menuRef}
                        role="menu"
                      >
                        <button
                          className={styles.menuItem}
                          onClick={() =>
                            closeForAction(() => onEdit(server.serverId))
                          }
                          role="menuitem"
                          type="button"
                        >
                          编辑服务器
                        </button>
                        {onDelete ? (
                          <button
                            className={`${styles.menuItem} ${styles.dangerMenuItem}`}
                            onClick={() =>
                              closeForAction(() => onDelete(server.serverId))
                            }
                            role="menuitem"
                            type="button"
                          >
                            删除服务器
                          </button>
                        ) : null}
                      </div>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          ) : !isLoading && configurationErrorSummary === null ? (
            <div className={styles.emptyState}>
              <strong>还没有保存的服务器</strong>
              <span>新建服务器后即可在这里连接</span>
              <button
                className={styles.emptyCreateButton}
                onClick={() => closeForAction(onCreate)}
                type="button"
              >
                新建第一个服务器
              </button>
            </div>
          ) : null}
        </section>
      ) : null}

      <button
        aria-controls={panelId}
        aria-expanded={isOpen}
        aria-haspopup="dialog"
        aria-label={`${currentName}，${currentStatus}，${
          isOpen ? "关闭" : "打开"
        }服务器选择器`}
        className={styles.trigger}
        data-high-risk={currentHighRisk || undefined}
        data-phase={currentPhase}
        onClick={() => {
          if (isOpen) {
            setOpenMenuServerId(null);
          }
          setIsOpen((open) => !open);
        }}
        ref={triggerRef}
        type="button"
      >
        <span className={styles.triggerIcon}>
          <ServerIcon />
        </span>
        <span className={styles.triggerText}>
          <strong>{currentName}</strong>
          <span>{currentStatus}</span>
        </span>
        {currentPhase === "ready" ? null : (
          <span
            aria-hidden="true"
            className={styles.triggerStatusDot}
            data-connection-indicator
          />
        )}
        <span
          aria-hidden="true"
          className={styles.expandIcon}
          data-open={isOpen}
        >
          <ExpandIcon />
        </span>
      </button>
    </div>
  );
}
