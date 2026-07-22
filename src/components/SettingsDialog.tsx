import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";

import type { ProxyId, ProxyProfile, ServerId, ServerProfile } from "../configuration";
import type { PermissionProfileSummary } from "../protocol/generated/types/PermissionProfileListResponse";
import type {
  AppPreferences,
  PreferencesStore,
  SystemDiagnostics,
} from "../transport/preferences";
import type { ConnectionPhase } from "../store/connectionSlice";
import type { DesktopNotificationPermission } from "../transport/desktopNotifications";
import {
  readConversationLoadDiagnostics,
  type ConversationLoadDiagnostic,
} from "../diagnostics/conversationLoadDiagnostics";
import type { ServerConnectionView } from "./ServerSwitcher";
import { useModalLayer } from "./modalStack";
import styles from "./SettingsDialog.module.css";

export type SettingsSection = "appearance" | "general" | "notifications" | "servers" | "proxies" | "permissions" | "privacy" | "shortcuts" | "diagnostics";

const SECTIONS: readonly { readonly id: SettingsSection; readonly label: string }[] = [
  { id: "appearance", label: "外观" },
  { id: "general", label: "通用" },
  { id: "notifications", label: "通知" },
  { id: "servers", label: "服务器" },
  { id: "proxies", label: "代理" },
  { id: "permissions", label: "权限" },
  { id: "privacy", label: "数据与隐私" },
  { id: "shortcuts", label: "快捷键" },
  { id: "diagnostics", label: "诊断" },
];

export interface SettingsDialogProps {
  readonly open: boolean;
  readonly initialSection?: SettingsSection;
  readonly preferences: AppPreferences;
  readonly preferencesError: string | null;
  readonly preferencesLoading: boolean;
  readonly preferencesSaving: boolean;
  readonly preferencesStore: PreferencesStore;
  readonly servers: readonly ServerProfile[];
  readonly proxies: readonly ProxyProfile[];
  readonly permissionProfiles: readonly PermissionProfileSummary[];
  readonly connectionPhase: ConnectionPhase;
  readonly currentConnectionStage: string | null;
  readonly recentConnectionError: string | null;
  readonly currentServerName: string;
  readonly currentServer: ServerProfile | null;
  readonly serverConnectionViews: Readonly<Record<string, ServerConnectionView | undefined>>;
  readonly onClose: () => void;
  readonly onEditServer: (serverId: ServerId) => void;
  readonly onNewServer: () => void;
  readonly onConnectServer: (serverId: ServerId) => void;
  readonly onOpenServerInNewWindow: (serverId: ServerId) => void;
  readonly onDeleteServer: (serverId: ServerId) => void;
  readonly onEditProxy: (proxyId: ProxyId) => void;
  readonly onNewProxy: () => void;
  readonly onDeleteProxy: (proxyId: ProxyId) => void;
  readonly onUpdatePreferences: (patch: Partial<AppPreferences>) => void;
  readonly notificationPermission: DesktopNotificationPermission;
  readonly onBeforeClearAllLocalData: () => Promise<void>;
  readonly onAllLocalDataCleared: () => void;
}

type CleanupKind = "logs" | "temporary" | "all";
type CleanupStatus = "confirm" | "clearing" | "cleared" | "error";

export function SettingsDialog(props: SettingsDialogProps) {
  if (!props.open) return null;
  return <SettingsDialogContent {...props} />;
}

function SettingsDialogContent({
  preferences,
  preferencesError,
  preferencesLoading,
  preferencesSaving,
  preferencesStore,
  servers,
  proxies,
  permissionProfiles,
  connectionPhase,
  currentConnectionStage,
  recentConnectionError,
  currentServerName,
  currentServer,
  serverConnectionViews,
  onClose,
  onEditServer,
  onNewServer,
  onConnectServer,
  onOpenServerInNewWindow,
  onDeleteServer,
  onEditProxy,
  onNewProxy,
  onDeleteProxy,
  onUpdatePreferences,
  initialSection = "appearance",
  notificationPermission,
  onBeforeClearAllLocalData,
  onAllLocalDataCleared,
}: SettingsDialogProps) {
  const [section, setSection] = useState<SettingsSection>(initialSection);
  const [diagnostics, setDiagnostics] = useState<SystemDiagnostics | null>(null);
  const [diagnosticsError, setDiagnosticsError] = useState<string | null>(null);
  const [cleanupState, setCleanupState] = useState<{
    readonly kind: CleanupKind;
    readonly status: CleanupStatus;
  } | null>(null);
  const [copied, setCopied] = useState(false);
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const isTopmostModal = useModalLayer();

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeRef.current?.focus();
    return () => previous?.focus();
  }, []);

  useEffect(() => {
    if (section !== "diagnostics" || diagnostics !== null) return;
    let active = true;
    void preferencesStore.readDiagnostics().then(
      (report) => {
        if (active) {
          setDiagnostics(report);
          setDiagnosticsError(null);
        }
      },
      () => {
        if (active) setDiagnosticsError("无法读取系统诊断信息");
      },
    );
    return () => { active = false; };
  }, [diagnostics, preferencesStore, section]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!isTopmostModal()) return;
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== "Tab" || panelRef.current === null) return;
      const focusable = [...panelRef.current.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])')];
      const first = focusable[0];
      const last = focusable.at(-1);
      if (first === undefined || last === undefined) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isTopmostModal, onClose]);

  const diagnosticText = useMemo(() => diagnostics === null ? "" : buildDiagnosticReport({
    diagnostics,
    connectionPhase,
    currentConnectionStage,
    currentServerName,
    currentProxyType: currentProxyLabel(currentServer, proxies),
    recentConnectionError,
    serverCount: servers.length,
    conversationLoads: readConversationLoadDiagnostics(),
  }), [connectionPhase, currentConnectionStage, currentServer, currentServerName, diagnostics, proxies, recentConnectionError, servers.length]);

  const clearData = async (kind: CleanupKind) => {
    setCleanupState({ kind, status: "clearing" });
    try {
      switch (kind) {
        case "logs":
          await preferencesStore.clearApplicationLogs();
          break;
        case "temporary":
          await preferencesStore.clearTemporaryFiles();
          break;
        case "all":
          await onBeforeClearAllLocalData();
          await preferencesStore.clearAllLocalData();
          setCleanupState({ kind, status: "cleared" });
          onAllLocalDataCleared();
          return;
      }
      setCleanupState({ kind, status: "cleared" });
    } catch {
      setCleanupState({ kind, status: "error" });
    }
  };

  return (
    <div className={styles.backdrop}>
      <div aria-labelledby={titleId} aria-modal="true" className={styles.dialog} ref={panelRef} role="dialog">
        <aside>
          <h1 id={titleId}>设置</h1>
          <nav aria-label="设置分区">
            {SECTIONS.map((item) => <button aria-current={section === item.id ? "page" : undefined} key={item.id} onClick={() => setSection(item.id)} type="button">{item.label}</button>)}
          </nav>
        </aside>
        <main>
          <header><div><strong>{SECTIONS.find(({ id }) => id === section)?.label}</strong>{preferencesSaving ? <small>正在保存</small> : null}</div><button aria-label="关闭设置" onClick={onClose} ref={closeRef} type="button">×</button></header>
          {preferencesError ? <p className={styles.error} role="status">{preferencesError}</p> : null}
          <div className={styles.content}>
            {section === "appearance" ? <AppearanceSection disabled={preferencesLoading} preferences={preferences} update={onUpdatePreferences} /> : null}
            {section === "general" ? <GeneralSection disabled={preferencesLoading} preferences={preferences} update={onUpdatePreferences} /> : null}
            {section === "notifications" ? <NotificationsSection disabled={preferencesLoading} permission={notificationPermission} preferences={preferences} update={onUpdatePreferences} /> : null}
            {section === "servers" ? <ServersSection currentServerId={currentServer?.serverId ?? null} onConnect={onConnectServer} onDelete={onDeleteServer} onEdit={onEditServer} onNew={onNewServer} onOpenInNewWindow={onOpenServerInNewWindow} serverConnectionViews={serverConnectionViews} servers={servers} /> : null}
            {section === "proxies" ? <ProxiesSection onDelete={onDeleteProxy} onEdit={onEditProxy} onNew={onNewProxy} proxies={proxies} /> : null}
            {section === "permissions" ? <PermissionsSection profiles={permissionProfiles} /> : null}
            {section === "privacy" ? <PrivacySection clearData={clearData} state={cleanupState} setState={setCleanupState} /> : null}
            {section === "shortcuts" ? <ShortcutsSection /> : null}
            {section === "diagnostics" ? (
              <DiagnosticsSection
                copied={copied}
                error={diagnosticsError}
                report={diagnosticText}
                onCopy={() => void navigator.clipboard.writeText(diagnosticText).then(() => {
                  setCopied(true);
                  window.setTimeout(() => setCopied(false), 1_500);
                }, () => setDiagnosticsError("无法复制诊断报告"))}
              />
            ) : null}
          </div>
        </main>
      </div>
    </div>
  );
}

function AppearanceSection({ disabled, preferences, update }: PreferenceSectionProps) {
  return <Section title="主题" description="跟随系统，或为所有窗口固定浅色或深色主题"><div className={styles.segmented}>{(["system", "light", "dark"] as const).map((theme) => <label key={theme}><input checked={preferences.theme === theme} disabled={disabled} name="theme" onChange={() => update({ theme })} type="radio" /><span>{theme === "system" ? "跟随系统" : theme === "light" ? "浅色" : "深色"}</span></label>)}</div></Section>;
}

function GeneralSection({ disabled, preferences, update }: PreferenceSectionProps) {
  return <><Section title="编辑器" description="Enter 发送，Shift+Enter 换行"><Toggle checked={preferences.codeWrap} disabled={disabled} label="代码和文本预览默认折行" onChange={(codeWrap) => update({ codeWrap })} /></Section><Section title="连接恢复" description="非主动断线会按 1、2、5、10、20、30 秒退避自动重连，可在连接错误页停止" /></>;
}

function NotificationsSection({ disabled, preferences, update, permission }: PreferenceSectionProps & { readonly permission: DesktopNotificationPermission }) {
  const permissionText = permission === "granted" ? "系统通知权限已允许" : permission === "denied" ? "系统已拒绝通知权限，可在桌面环境设置中修改" : permission === "unsupported" ? "当前 WebView 不支持系统通知" : "首次启用时会请求系统通知权限";
  return <Section title="桌面通知" description={`仅在相应窗口不活跃时发送，不包含用户消息或文件正文 · ${permissionText}`}><Toggle checked={preferences.notifyTaskComplete} disabled={disabled} label="任务完成" onChange={(notifyTaskComplete) => update({ notifyTaskComplete })} /><Toggle checked={preferences.notifyApproval} disabled={disabled} label="等待审批" onChange={(notifyApproval) => update({ notifyApproval })} /><Toggle checked={preferences.notifyConnectionFailure} disabled={disabled} label="连接失败" onChange={(notifyConnectionFailure) => update({ notifyConnectionFailure })} /></Section>;
}

function ServersSection({ currentServerId, onConnect, onDelete, onEdit, onNew, onOpenInNewWindow, serverConnectionViews, servers }: { readonly currentServerId: ServerId | null; readonly onConnect: (id: ServerId) => void; readonly onDelete: (id: ServerId) => void; readonly onEdit: (id: ServerId) => void; readonly onNew: () => void; readonly onOpenInNewWindow: (id: ServerId) => void; readonly serverConnectionViews: Readonly<Record<string, ServerConnectionView | undefined>>; readonly servers: readonly ServerProfile[] }) {
  return <Section title="服务器" description="与侧边栏共用连接、窗口、编辑、删除和校验规则"><button className={styles.primary} onClick={onNew} type="button">新建服务器</button><div className={styles.rows}>{servers.length === 0 ? <p className={styles.muted}>尚未保存服务器</p> : servers.map((server) => {
    const view = serverConnectionViews[server.serverId] ?? { phase: "disconnected", errorSummary: null };
    const current = currentServerId === server.serverId;
    const busy = view.phase === "connecting" || view.phase === "initializing" || view.phase === "reconnecting";
    const ready = view.phase === "ready";
    const connectLabel = current && ready ? "当前已连接" : ready ? "切换" : busy ? serverPhaseLabel(view.phase) : "连接";
    return <article aria-current={current || undefined} key={server.serverId}><div><strong>{server.name}</strong><small>{server.configuration.type === "localStdio" ? "本机 stdio" : server.configuration.url} · {serverPhaseLabel(view.phase)}{view.errorSummary === null ? "" : ` · ${view.errorSummary}`}</small></div><span className={styles.rowActions}><button disabled={busy || (current && ready)} onClick={() => onConnect(server.serverId)} type="button">{connectLabel}</button><button onClick={() => onOpenInNewWindow(server.serverId)} type="button">新窗口</button><button onClick={() => onEdit(server.serverId)} type="button">编辑</button><button className={styles.dangerText} onClick={() => onDelete(server.serverId)} type="button">删除</button></span></article>;
  })}</div></Section>;
}

function ProxiesSection({ proxies, onNew, onEdit, onDelete }: { readonly proxies: readonly ProxyProfile[]; readonly onNew: () => void; readonly onEdit: (proxyId: ProxyId) => void; readonly onDelete: (proxyId: ProxyId) => void }) {
  return <Section title="代理" description="远程服务器明确选择直连或一个已保存代理，失败时不会回退直连"><button className={styles.primary} onClick={onNew} type="button">新建代理</button><div className={styles.rows}>{proxies.length === 0 ? <p className={styles.muted}>尚未保存代理</p> : proxies.map((proxy) => <article key={proxy.proxyId}><div><strong>{proxy.name}</strong><small>{proxyLabel(proxy)} · {proxy.referencedServerCount} 个服务器引用{proxy.lastTest ? ` · 最近测试${proxy.lastTest.status === "succeeded" ? "成功" : "失败"}` : ""}</small></div><span className={styles.rowActions}><button onClick={() => onEdit(proxy.proxyId)} type="button">编辑</button><button onClick={() => onDelete(proxy.proxyId)} type="button">删除</button></span></article>)}</div></Section>;
}

function PermissionsSection({ profiles }: { readonly profiles: readonly PermissionProfileSummary[] }) {
  return <Section title="权限配置" description="权限选择只影响后续回合；额外权限仍通过独立审批面板确认"><div className={styles.rows}>{profiles.length === 0 ? <p className={styles.muted}>连接服务器后读取权限配置</p> : profiles.map((profile) => <article key={profile.id}><div><strong>{profile.id}</strong><small>{profile.description ?? "服务器权限配置"}{profile.allowed ? "" : " · 当前不可选"}</small></div></article>)}</div></Section>;
}

function PrivacySection({ clearData, setState, state }: { readonly clearData: (kind: CleanupKind) => Promise<void>; readonly setState: (state: { readonly kind: CleanupKind; readonly status: CleanupStatus } | null) => void; readonly state: { readonly kind: CleanupKind; readonly status: CleanupStatus } | null }) {
  const rows = [
    { kind: "logs", title: "清理日志", description: "删除应用日志目录中的持久化诊断日志" },
    { kind: "temporary", title: "清理临时文件", description: "删除 /tmp/codex-desktop-linux 中的预览和保存中间文件" },
    { kind: "all", title: "清理全部本地数据", description: "删除服务器、代理、窗口、偏好、草稿、常用提示词以及凭据存储中的凭据" },
  ] as const;
  return <Section title="本地数据" description="清理只影响此客户端的本地数据，不会删除 app-server 上的会话或文件">{rows.map((row) => {
    const active = state?.kind === row.kind ? state.status : null;
    return <div className={styles.dangerRow} key={row.kind}><div><strong>{row.title}</strong><small>{row.description}</small></div>{active === "confirm" ? <span><button onClick={() => setState(null)} type="button">取消</button><button className={row.kind === "all" ? styles.danger : undefined} onClick={() => void clearData(row.kind)} type="button">确认{row.title}</button></span> : <button aria-label={row.title} className={row.kind === "all" ? styles.danger : undefined} disabled={active === "clearing"} onClick={() => setState({ kind: row.kind, status: "confirm" })} type="button">{active === "clearing" ? "清理中" : "清理"}</button>}{active === "cleared" ? <span className={styles.inlineSuccess} role="status">已清理</span> : active === "error" ? <span className={styles.inlineError} role="alert">清理失败，请重试</span> : null}</div>;
  })}</Section>;
}

function ShortcutsSection() {
  const shortcuts = [["Ctrl+N", "新建会话"], ["Ctrl+Shift+N", "在新窗口新建会话"], ["Ctrl+K", "快速切换会话"], ["Ctrl+,", "打开设置"], ["Ctrl+L", "聚焦输入框"], ["Ctrl+Enter", "发送"], ["Ctrl+Shift+C", "复制当前 AI 回答 Markdown"], ["Esc", "关闭最上层浮层"]] as const;
  return <Section title="默认快捷键" description="文本编辑器中的常见编辑操作保持不变"><dl className={styles.shortcuts}>{shortcuts.map(([key, label]) => <div key={key}><dt><kbd>{key}</kbd></dt><dd>{label}</dd></div>)}</dl></Section>;
}

function DiagnosticsSection({ copied, error, onCopy, report }: { readonly copied: boolean; readonly error: string | null; readonly onCopy: () => void; readonly report: string }) {
  return <Section title="只读诊断" description="报告不包含用户消息、文件正文、令牌、Cookie、认证头、SSH 认证数据或完整环境变量"><button className={styles.primary} disabled={report.length === 0} onClick={onCopy} type="button">{copied ? "已复制" : "复制脱敏诊断报告"}</button>{error ? <p className={styles.error} role="status">{error}</p> : report.length === 0 ? <p className={styles.muted}>正在读取诊断信息</p> : <pre className={styles.report}>{report}</pre>}</Section>;
}

function Section({ children, description, title }: { readonly children?: ReactNode; readonly description: string; readonly title: string }) {
  return <section className={styles.section}><header><h2>{title}</h2><p>{description}</p></header>{children}</section>;
}

function Toggle({ checked, disabled, label, onChange }: { readonly checked: boolean; readonly disabled: boolean; readonly label: string; readonly onChange: (checked: boolean) => void }) {
  return <label className={styles.toggle}><span>{label}</span><input checked={checked} disabled={disabled} onChange={(event) => onChange(event.target.checked)} type="checkbox" /></label>;
}

interface PreferenceSectionProps { readonly disabled: boolean; readonly preferences: AppPreferences; readonly update: (patch: Partial<AppPreferences>) => void }

function proxyLabel(proxy: ProxyProfile): string {
  switch (proxy.configuration.type) {
    case "httpConnect": return `HTTP CONNECT · ${proxy.configuration.url}`;
    case "socks5": return `SOCKS5 · ${proxy.configuration.host}:${proxy.configuration.port}`;
    case "ssh": return `SSH · ${proxy.configuration.username}@${proxy.configuration.host}:${proxy.configuration.port}`;
  }
}

function serverPhaseLabel(phase: ServerConnectionView["phase"]): string {
  switch (phase) {
    case "disconnected": return "未连接";
    case "connecting": return "连接中";
    case "initializing": return "初始化中";
    case "ready": return "已连接";
    case "reconnecting": return "重连中";
    case "error": return "连接错误";
  }
}

function buildDiagnosticReport(input: { readonly diagnostics: SystemDiagnostics; readonly connectionPhase: ConnectionPhase; readonly currentConnectionStage: string | null; readonly currentServerName: string; readonly currentProxyType: string; readonly recentConnectionError: string | null; readonly serverCount: number; readonly conversationLoads: readonly ConversationLoadDiagnostic[] }): string {
  return [
    `Codex Desktop Linux ${input.diagnostics.clientVersion}`,
    `协议基线 ${input.diagnostics.protocolBaseline}`,
    `系统 ${input.diagnostics.operatingSystem}/${input.diagnostics.architecture}`,
    `WebView ${input.diagnostics.webviewVersion ?? "未知"}`,
    `会话 ${input.diagnostics.sessionType ?? "未知"}`,
    `桌面 ${input.diagnostics.desktop ?? "未知"}`,
    `服务器 ${input.currentServerName}`,
    `代理类型 ${input.currentProxyType}`,
    `连接状态 ${input.connectionPhase}`,
    `当前阶段 ${input.currentConnectionStage ?? "无"}`,
    `最近错误 ${input.recentConnectionError ?? "无"}`,
    `已保存服务器 ${input.serverCount}`,
    ...conversationLoadReport(input.conversationLoads),
  ].join("\n");
}

function conversationLoadReport(
  samples: readonly ConversationLoadDiagnostic[],
): readonly string[] {
  if (samples.length === 0) {
    return ["会话恢复耗时 当前进程暂无记录"];
  }
  return samples.slice(0, 5).map((sample, index) => [
    `会话恢复 ${index + 1}`,
    conversationLoadStatusLabel(sample.status),
    `总耗时 ${durationLabel(sample.totalMs)}`,
    `响应等待 ${durationLabel(sample.responseWaitMs)}`,
    `JSON 解析 ${durationLabel(sample.jsonParseMs)}`,
    `协议校验 ${durationLabel(sample.protocolValidationMs)}`,
    `投影 ${durationLabel(sample.projectionMs)}`,
    `首次提交 ${durationLabel(sample.renderCommitMs)}`,
    `响应字符 ${sample.responseCharacters ?? "未记录"}`,
    `回合/项目 ${sample.turnCount ?? "未记录"}/${sample.itemCount ?? "未记录"}`,
  ].join(" · "));
}

function conversationLoadStatusLabel(status: ConversationLoadDiagnostic["status"]): string {
  switch (status) {
    case "pending": return "进行中";
    case "succeeded": return "成功";
    case "failed": return "失败";
  }
}

function durationLabel(value: number | null): string {
  return value === null ? "未记录" : `${value.toFixed(1)}ms`;
}

function currentProxyLabel(
  server: ServerProfile | null,
  proxies: readonly ProxyProfile[],
): string {
  if (server === null || server.configuration.type === "localStdio") {
    return "无";
  }
  if (server.configuration.proxyId === undefined) {
    return "直连";
  }
  const selectedProxyId = server.configuration.proxyId;
  const proxy = proxies.find(({ proxyId }) => proxyId === selectedProxyId);
  return proxy === undefined ? "引用不可用" : proxyLabel(proxy).split(" · ", 1)[0] ?? "未知";
}
