import { useEffect, useId, useRef, useState, type FormEvent } from "react";

import type { ServerId, ServerProfile, TlsCertificatePolicy } from "../configuration";
import {
  buildProxyEditorSubmission,
  createProxyEditorDraft,
  existingProxyCredentialType,
  proxyFormError,
  type HttpProxyDraft,
  type KeyValueDraft,
  type ProxyEditorDraft,
  type ProxyEditorFieldName,
  type ProxyEditorMode,
  type ProxyEditorSubmission,
  type ProxySshHostKeyDraft,
  type Socks5ProxyDraft,
  type SshProxyDraft,
} from "./proxyEditorModel";
import type { ServerEditorTestState, SshHostKeyPrompt } from "./serverEditorModel";
import { useModalLayer } from "./modalStack";
import serverStyles from "./ServerEditorDialog.module.css";
import styles from "./ProxyEditorDialog.module.css";

export interface ProxyEditorDialogProps {
  readonly open: boolean;
  readonly mode: ProxyEditorMode;
  readonly saving: boolean;
  readonly error?: string | undefined;
  readonly remoteServers: readonly ServerProfile[];
  readonly testState?: ServerEditorTestState | undefined;
  readonly onCancel: () => void;
  readonly onSubmit: (submission: ProxyEditorSubmission) => void;
  readonly onRemoveHostKey?: (() => void) | undefined;
  readonly onTest?: ((serverId: ServerId, submission: ProxyEditorSubmission) => void) | undefined;
  readonly onCancelTest?: (() => void) | undefined;
  readonly onConfirmHostKey?: ((prompt: Extract<SshHostKeyPrompt, { readonly kind: "unknown" }>) => void) | undefined;
}

export function ProxyEditorDialog(props: ProxyEditorDialogProps) {
  if (!props.open) return null;
  const key = props.mode.type === "create" ? "create" : `${props.mode.profile.proxyId}:${props.mode.profile.version}`;
  return <ProxyEditorDialogContent key={key} {...props} />;
}

function ProxyEditorDialogContent({
  mode,
  saving,
  error,
  remoteServers,
  testState,
  onCancel,
  onSubmit,
  onRemoveHostKey,
  onTest,
  onCancelTest,
  onConfirmHostKey,
}: ProxyEditorDialogProps) {
  const [draft, setDraft] = useState(() => createProxyEditorDraft(mode));
  const [draftHostKey, setDraftHostKey] = useState<ProxySshHostKeyDraft | undefined>(() => mode.type === "edit"
    ? mode.profile.sshHostKey
    : undefined);
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<ProxyEditorFieldName, string>>>({});
  const [testServerId, setTestServerId] = useState<string>(remoteServers[0]?.serverId ?? "");
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const isTopmostModal = useModalLayer();
  const testing = testState?.type === "testing" || testState?.type === "cancelling" || testState?.type === "cancelFailed";

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    panelRef.current?.querySelector<HTMLElement>("input")?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (!isTopmostModal()) return;
      if (event.key === "Escape" && !saving && !testing) {
        event.preventDefault();
        onCancel();
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
    window.addEventListener("keydown", keydown);
    return () => {
      window.removeEventListener("keydown", keydown);
      previous?.focus();
    };
  }, [isTopmostModal, onCancel, saving, testing]);

  useEffect(() => {
    if (draftHostKey === undefined || mode.type === "edit" && mode.profile.sshHostKey !== undefined) return;
    if (
      draft.proxyType !== "ssh" ||
      draft.ssh.host !== draftHostKey.host ||
      Number(draft.ssh.port) !== draftHostKey.port
    ) {
      setDraftHostKey(undefined);
    }
  }, [draft.proxyType, draft.ssh.host, draft.ssh.port, draftHostKey, mode]);

  const clearError = (field: ProxyEditorFieldName) => setFieldErrors((current) => {
    if (current[field] === undefined) return current;
    const next = { ...current };
    delete next[field];
    return next;
  });
  const update = (patch: Partial<ProxyEditorDraft>) => setDraft((current) => ({ ...current, ...patch }));
  const updateHttp = (patch: Partial<HttpProxyDraft>) => setDraft((current) => ({ ...current, httpConnect: { ...current.httpConnect, ...patch } }));
  const updateSocks = (patch: Partial<Socks5ProxyDraft>) => setDraft((current) => ({ ...current, socks5: { ...current.socks5, ...patch } }));
  const updateSsh = (patch: Partial<SshProxyDraft>) => setDraft((current) => ({ ...current, ssh: { ...current.ssh, ...patch } }));

  const submit = (event: FormEvent) => {
    event.preventDefault();
    try {
      setFieldErrors({});
      onSubmit(buildProxyEditorSubmission(mode, draft, draftHostKey));
    } catch (unknownError) {
      const issue = proxyFormError(unknownError);
      setFieldErrors({ [issue.field]: issue.message });
    }
  };
  const test = () => {
    try {
      setFieldErrors({});
      onTest?.(
        testServerId as ServerId,
        buildProxyEditorSubmission(mode, draft, draftHostKey),
      );
    } catch (unknownError) {
      const issue = proxyFormError(unknownError);
      setFieldErrors({ [issue.field]: issue.message });
    }
  };
  const savedCredential = mode.type === "edit" ? existingProxyCredentialType(mode.profile) : undefined;

  return (
    <div className={serverStyles.backdrop}>
      <div aria-labelledby={titleId} aria-modal="true" className={serverStyles.dialog} ref={panelRef} role="dialog">
        <header className={serverStyles.header}>
          <div><h2 id={titleId}>{mode.type === "create" ? "新建代理" : "编辑代理"}</h2><p>代理仅用于远程 WebSocket，认证凭据保存在 Secret Service</p></div>
          <button aria-label="关闭代理编辑器" className={serverStyles.closeButton} disabled={saving || testing} onClick={onCancel} type="button">×</button>
        </header>
        <form className={serverStyles.form} onSubmit={submit}>
          <fieldset className={serverStyles.disabledGroup} disabled={saving || testing}>
            <div className={serverStyles.body}>
              <fieldset className={serverStyles.typeChooser}>
                <legend>代理类型</legend>
                {(["httpConnect", "socks5", "ssh"] as const).map((type) => <label key={type}><input checked={draft.proxyType === type} name="proxy-type" onChange={() => { update({ proxyType: type }); clearError("proxyType"); }} type="radio" /><span><strong>{type === "httpConnect" ? "HTTP CONNECT" : type === "socks5" ? "SOCKS5" : "SSH 隧道"}</strong><small>{type === "httpConnect" ? "经 HTTP/HTTPS 代理建立隧道" : type === "socks5" ? "支持本地或代理 DNS" : "使用 direct-tcpip，不监听本机端口"}</small></span></label>)}
              </fieldset>
              <ErrorText message={fieldErrors.proxyType} />
              <Field label="名称" error={fieldErrors.name}><input onChange={(event) => { update({ name: event.target.value }); clearError("name"); }} placeholder="例如：开发机代理" value={draft.name} /></Field>
              {draft.proxyType === "httpConnect" ? <HttpFields draft={draft.httpConnect} errors={fieldErrors} onChange={updateHttp} clearError={clearError} /> : null}
              {draft.proxyType === "socks5" ? <SocksFields draft={draft.socks5} errors={fieldErrors} onChange={updateSocks} clearError={clearError} /> : null}
              {draft.proxyType === "ssh" ? <SshFields draft={draft.ssh} errors={fieldErrors} onChange={updateSsh} clearError={clearError} /> : null}
              {savedCredential === undefined ? null : <div className={styles.credentialSummary}><span>{draft.clearExistingCredential ? "保存时将清除已保存的代理凭据" : "已保存代理凭据；留空将继续使用"}</span><button onClick={() => update({ clearExistingCredential: !draft.clearExistingCredential })} type="button">{draft.clearExistingCredential ? "撤销清除" : "清除凭据"}</button></div>}
              <ErrorText message={fieldErrors.credential} />
              {draftHostKey === undefined ? null : <div className={styles.hostKey}><strong>{mode.type === "edit" && mode.profile.sshHostKey !== undefined ? "已绑定 SSH 主机密钥" : "草稿中的 SSH 主机密钥"}</strong><span>{draftHostKey.algorithm}</span><code>{draftHostKey.sha256Fingerprint}</code>{mode.type === "edit" && mode.profile.sshHostKey !== undefined && onRemoveHostKey ? <button onClick={onRemoveHostKey} type="button">移除主机密钥</button> : null}</div>}
              <label className={styles.testTarget}><span>连接测试目标</span><select disabled={remoteServers.length === 0} onChange={(event) => setTestServerId(event.target.value)} value={testServerId}>{remoteServers.length === 0 ? <option value="">没有可用远程服务器</option> : remoteServers.map((server) => <option key={server.serverId} value={server.serverId}>{server.name}</option>)}</select><small>使用当前未保存草稿执行代理连接、WebSocket 握手和 app-server 初始化，不创建会话或保存凭据</small></label>
              {testState === undefined ? null : <div className={serverStyles.testStatus} data-status={testState.type} role={testState.type === "failed" || testState.type === "cancelFailed" ? "alert" : "status"}>{testState.type === "testing" ? "正在测试代理连接…" : testState.type === "cancelling" ? "正在取消测试…" : testState.type === "succeeded" ? testState.message ?? "代理连接测试成功" : testState.message}</div>}
              {testState?.type === "failed" && testState.sshHostKeyPrompt !== undefined ? <HostKeyPrompt onConfirm={(prompt) => { setDraftHostKey({ host: prompt.host, port: prompt.port, algorithm: prompt.algorithm, sha256Fingerprint: prompt.sha256Fingerprint }); onConfirmHostKey?.(prompt); }} prompt={testState.sshHostKeyPrompt} /> : null}
              {error === undefined ? null : <div className={serverStyles.submitError} role="alert">{error}</div>}
            </div>
          </fieldset>
          <footer className={serverStyles.footer}>
            <button className={serverStyles.secondaryButton} disabled={saving || testing} onClick={onCancel} type="button">取消</button>
            {onTest && onCancelTest ? <button className={serverStyles.secondaryButton} disabled={saving || testServerId.length === 0 || testState?.type === "cancelling" || testState?.type === "cancelFailed"} onClick={() => testState?.type === "testing" ? onCancelTest() : test()} type="button">{testState?.type === "testing" ? "取消测试" : "测试连接"}</button> : null}
            <button className={serverStyles.primaryButton} disabled={saving || testing} type="submit">{saving ? "正在保存" : "保存"}</button>
          </footer>
        </form>
      </div>
    </div>
  );
}

function HttpFields({ draft, errors, onChange, clearError }: FieldProps<HttpProxyDraft>) {
  return <section aria-label="HTTP CONNECT 配置" className={serverStyles.section}><div className={serverStyles.sectionHeading}><h3>HTTP CONNECT</h3><p>目标请求头不会发送给代理</p></div><Field label="代理 URL" error={errors.url}><input inputMode="url" onChange={(event) => { onChange({ url: event.target.value }); clearError("url"); }} placeholder="https://proxy.example.com:443" value={draft.url} /></Field><div className={serverStyles.twoColumns}><Field label="认证方式" error={errors.authentication}><select onChange={(event) => { onChange({ authentication: event.target.value as HttpProxyDraft["authentication"], secret: "" }); clearError("authentication"); clearError("credential"); }} value={draft.authentication}><option value="none">无认证</option><option value="basic">Basic</option><option value="bearer">Bearer</option></select></Field><NumberField label="连接超时（毫秒）" value={draft.connectTimeoutMs} onChange={(connectTimeoutMs) => { onChange({ connectTimeoutMs }); clearError("connectTimeoutMs"); }} error={errors.connectTimeoutMs} /></div>{draft.authentication === "basic" ? <Field label="用户名" error={errors.username}><input autoComplete="username" onChange={(event) => { onChange({ username: event.target.value }); clearError("username"); }} value={draft.username} /></Field> : null}{draft.authentication !== "none" ? <SecretField label={draft.authentication === "basic" ? "密码" : "Bearer 令牌"} value={draft.secret} onChange={(secret) => { onChange({ secret }); clearError("credential"); }} /> : null}<KeyValueEditor values={draft.nonSensitiveHeaders} onChange={(nonSensitiveHeaders) => { onChange({ nonSensitiveHeaders }); clearError("nonSensitiveHeaders"); }} error={errors.nonSensitiveHeaders} /><Field label="代理 TLS 证书策略" error={errors.tlsCertificatePolicy}><select onChange={(event) => { onChange({ tlsCertificatePolicy: event.target.value as TlsCertificatePolicy }); clearError("tlsCertificatePolicy"); }} value={draft.tlsCertificatePolicy}><option value="strict">严格校验证书</option><option value="allowInvalidCertificate">允许无效证书（高风险）</option></select></Field>{draft.tlsCertificatePolicy === "allowInvalidCertificate" ? <p className={styles.warning}>仅用于受控开发环境，代理证书将不再验证</p> : null}</section>;
}

function SocksFields({ draft, errors, onChange, clearError }: FieldProps<Socks5ProxyDraft>) {
  return <section aria-label="SOCKS5 配置" className={serverStyles.section}><div className={serverStyles.sectionHeading}><h3>SOCKS5</h3><p>默认由代理解析目标域名，减少本地 DNS 泄漏</p></div><div className={serverStyles.twoColumns}><Field label="主机" error={errors.host}><input onChange={(event) => { onChange({ host: event.target.value }); clearError("host"); }} placeholder="127.0.0.1" value={draft.host} /></Field><NumberField label="端口" value={draft.port} onChange={(port) => { onChange({ port }); clearError("port"); }} error={errors.port} /></div><div className={serverStyles.twoColumns}><Field label="认证方式" error={errors.authentication}><select onChange={(event) => { onChange({ authentication: event.target.value as Socks5ProxyDraft["authentication"], password: "" }); clearError("authentication"); clearError("credential"); }} value={draft.authentication}><option value="none">无认证</option><option value="usernamePassword">用户名与密码</option></select></Field><Field label="DNS 解析" error={errors.dnsResolution}><select onChange={(event) => onChange({ dnsResolution: event.target.value as Socks5ProxyDraft["dnsResolution"] })} value={draft.dnsResolution}><option value="proxy">代理解析（推荐）</option><option value="local">本机解析</option></select></Field></div>{draft.authentication === "usernamePassword" ? <><Field label="用户名" error={errors.username}><input autoComplete="username" onChange={(event) => { onChange({ username: event.target.value }); clearError("username"); }} value={draft.username} /></Field><SecretField label="密码" value={draft.password} onChange={(password) => { onChange({ password }); clearError("credential"); }} /></> : null}<NumberField label="连接超时（毫秒）" value={draft.connectTimeoutMs} onChange={(connectTimeoutMs) => { onChange({ connectTimeoutMs }); clearError("connectTimeoutMs"); }} error={errors.connectTimeoutMs} /></section>;
}

function SshFields({ draft, errors, onChange, clearError }: FieldProps<SshProxyDraft>) {
  return <section aria-label="SSH 隧道配置" className={serverStyles.section}><div className={serverStyles.sectionHeading}><h3>SSH direct-tcpip</h3><p>主机密钥首次连接时必须确认，变化时会阻断连接</p></div><div className={serverStyles.twoColumns}><Field label="主机" error={errors.host}><input onChange={(event) => { onChange({ host: event.target.value }); clearError("host"); }} value={draft.host} /></Field><NumberField label="端口" value={draft.port} onChange={(port) => { onChange({ port }); clearError("port"); }} error={errors.port} /></div><Field label="用户名" error={errors.username}><input autoComplete="username" onChange={(event) => { onChange({ username: event.target.value }); clearError("username"); }} value={draft.username} /></Field><Field label="认证方式" error={errors.authentication}><select onChange={(event) => { onChange({ authentication: event.target.value as SshProxyDraft["authentication"], secret: "" }); clearError("authentication"); clearError("credential"); }} value={draft.authentication}><option value="agent">SSH Agent</option><option value="privateKey">私钥文件</option><option value="password">密码</option></select></Field>{draft.authentication === "privateKey" ? <><Field label="私钥路径" error={errors.privateKeyPath}><input onChange={(event) => { onChange({ privateKeyPath: event.target.value }); clearError("privateKeyPath"); }} placeholder="/home/user/.ssh/id_ed25519" value={draft.privateKeyPath} /></Field><SecretField label="私钥口令（可选）" value={draft.secret} onChange={(secret) => { onChange({ secret }); clearError("credential"); }} /></> : draft.authentication === "password" ? <SecretField label="SSH 密码" value={draft.secret} onChange={(secret) => { onChange({ secret }); clearError("credential"); }} /> : null}<div className={serverStyles.twoColumns}><NumberField label="连接超时（毫秒）" value={draft.connectTimeoutMs} onChange={(connectTimeoutMs) => { onChange({ connectTimeoutMs }); clearError("connectTimeoutMs"); }} error={errors.connectTimeoutMs} /><NumberField label="保活间隔（毫秒）" value={draft.keepAliveIntervalMs} onChange={(keepAliveIntervalMs) => { onChange({ keepAliveIntervalMs }); clearError("keepAliveIntervalMs"); }} error={errors.keepAliveIntervalMs} /></div><NumberField label="保活最大失败次数" value={draft.keepAliveMaxFailures} onChange={(keepAliveMaxFailures) => { onChange({ keepAliveMaxFailures }); clearError("keepAliveMaxFailures"); }} error={errors.keepAliveMaxFailures} /></section>;
}

interface FieldProps<Draft> { readonly draft: Draft; readonly errors: Partial<Record<ProxyEditorFieldName, string>>; readonly onChange: (patch: Partial<Draft>) => void; readonly clearError: (field: ProxyEditorFieldName) => void }

function Field({ children, error, label }: { readonly children: React.ReactNode; readonly error?: string | undefined; readonly label: string }) { return <label className={serverStyles.field}><span>{label}</span>{children}<ErrorText message={error} /></label>; }
function NumberField({ error, label, onChange, value }: { readonly error?: string | undefined; readonly label: string; readonly onChange: (value: string) => void; readonly value: string }) { return <Field label={label} error={error}><input inputMode="numeric" onChange={(event) => onChange(event.target.value)} type="number" value={value} /></Field>; }
function SecretField({ label, onChange, value }: { readonly label: string; readonly onChange: (value: string) => void; readonly value: string }) { return <Field label={label}><input autoComplete="new-password" onChange={(event) => onChange(event.target.value)} spellCheck={false} type="password" value={value} /><small>已保存凭据不会回填；填写内容只会提交到 Rust 凭据边界</small></Field>; }
function ErrorText({ message }: { readonly message?: string | undefined }) { return message === undefined ? null : <small className={serverStyles.fieldError} role="alert">{message}</small>; }

function HostKeyPrompt({ onConfirm, prompt }: { readonly onConfirm?: ((prompt: Extract<SshHostKeyPrompt, { readonly kind: "unknown" }>) => void) | undefined; readonly prompt: SshHostKeyPrompt }) {
  return <div className={styles.hostKey}><strong>{prompt.kind === "unknown" ? "确认新的 SSH 主机密钥" : "SSH 主机密钥已变化"}</strong><span>{prompt.host}:{prompt.port} · {prompt.algorithm}</span><code>{prompt.sha256Fingerprint}</code>{prompt.kind === "changed" ? <><span>已保存：{prompt.expectedAlgorithm}</span><code>{prompt.expectedSha256Fingerprint}</code><p className={styles.warning}>连接已阻断。如确认服务器已更换密钥，请先显式移除旧主机密钥，再重新测试并确认</p></> : onConfirm ? <button onClick={() => onConfirm(prompt)} type="button">确认并绑定此密钥</button> : null}</div>;
}

function KeyValueEditor({ error, onChange, values }: { readonly error?: string | undefined; readonly onChange: (values: readonly KeyValueDraft[]) => void; readonly values: readonly KeyValueDraft[] }) {
  const rows = values.length === 0 ? [{ name: "", value: "" }] : values;
  const update = (index: number, patch: Partial<KeyValueDraft>) => onChange(rows.map((row, itemIndex) => itemIndex === index ? { ...row, ...patch } : row));
  return <div className={serverStyles.field}><span>普通代理请求头</span><div className={styles.keyValues}>{rows.map((row, index) => <div className={styles.keyValueRow} key={index}><input aria-label={`请求头名称 ${index + 1}`} onChange={(event) => update(index, { name: event.target.value })} placeholder="X-Proxy-Client" value={row.name} /><input aria-label={`请求头值 ${index + 1}`} onChange={(event) => update(index, { value: event.target.value })} value={row.value} /><button aria-label={`删除请求头 ${index + 1}`} onClick={() => onChange(rows.filter((_, itemIndex) => itemIndex !== index))} type="button">×</button></div>)}</div><button className={styles.addButton} onClick={() => onChange([...rows, { name: "", value: "" }])} type="button">添加请求头</button><ErrorText message={error} /></div>;
}
