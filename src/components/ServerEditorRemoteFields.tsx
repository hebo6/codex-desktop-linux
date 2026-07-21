import type { ReactNode } from "react";

import type { ProxyProfile, TlsCertificatePolicy } from "../configuration";
import { FieldError, KeyValueList } from "./ServerEditorFields";
import type { ServerEditorFieldSupport } from "./ServerEditorFields";
import { isPlaintextWebSocketUrl, type RemoteDraft } from "./serverEditorModel";
import styles from "./ServerEditorDialog.module.css";

function proxyTypeLabel(proxy: ProxyProfile): string {
  switch (proxy.configuration.type) {
    case "httpConnect":
      return "HTTP CONNECT";
    case "socks5":
      return "SOCKS5";
    case "ssh":
      return "SSH";
  }
}

function proxyEndpoint(proxy: ProxyProfile): string {
  switch (proxy.configuration.type) {
    case "httpConnect":
      return proxy.configuration.url;
    case "socks5":
      return `${proxy.configuration.host}:${proxy.configuration.port}`;
    case "ssh":
      return `${proxy.configuration.username}@${proxy.configuration.host}:${proxy.configuration.port}`;
  }
}

interface ServerEditorRemoteFieldsProps {
  readonly draft: RemoteDraft;
  readonly proxies: readonly ProxyProfile[];
  readonly onChange: (patch: Partial<RemoteDraft>) => void;
  readonly onBearerInput: () => void;
  readonly onCreateProxy?: () => void;
  readonly credentialStatus: ReactNode;
  readonly support: ServerEditorFieldSupport;
}

export function ServerEditorRemoteFields({
  draft,
  proxies,
  onChange,
  onBearerInput,
  onCreateProxy,
  credentialStatus,
  support,
}: ServerEditorRemoteFieldsProps) {
  const isPlaintext = isPlaintextWebSocketUrl(draft.url);
  const selectedProxy = proxies.find(
    ({ proxyId }) => proxyId === draft.proxyId,
  );
  const selectedProxyMissing =
    draft.proxyId.length > 0 && selectedProxy === undefined;
  const selectedProxyAllowsInvalidCertificate =
    selectedProxy?.configuration.type === "httpConnect" &&
    selectedProxy.configuration.tlsCertificatePolicy ===
      "allowInvalidCertificate";

  return (
    <section aria-label="远程 WebSocket 配置" className={styles.section}>
      <div className={styles.sectionHeading}>
        <h3>远程连接</h3>
        <p>凭据优先保存到系统 Secret Service</p>
      </div>

      <label className={styles.field} htmlFor={support.fieldId("url")}>
        <span>WebSocket URL</span>
        <input
          aria-describedby={
            support.fieldErrors.url === undefined
              ? undefined
              : support.errorId("url")
          }
          aria-invalid={support.fieldErrors.url !== undefined}
          id={support.fieldId("url")}
          inputMode="url"
          onChange={(event) => {
            const url = event.target.value;
            onChange({
              url,
              ...(isPlaintextWebSocketUrl(url)
                ? { tlsCertificatePolicy: "strict" }
                : {}),
            });
            support.clearFieldError("url");
            support.clearFieldError("tlsCertificatePolicy");
            support.clearFieldError("plaintextConfirmed");
            support.clearFieldError("credential");
          }}
          placeholder="wss://example.com/codex"
          ref={support.registerField("url")}
          spellCheck={false}
          value={draft.url}
        />
        <FieldError
          id={support.errorId("url")}
          message={support.fieldErrors.url}
        />
      </label>

      {isPlaintext ? (
        <label
          className={styles.confirmation}
          htmlFor={support.fieldId("plaintextConfirmed")}
        >
          <input
            aria-describedby={
              support.fieldErrors.plaintextConfirmed === undefined
                ? undefined
                : support.errorId("plaintextConfirmed")
            }
            aria-invalid={support.fieldErrors.plaintextConfirmed !== undefined}
            checked={draft.plaintextConfirmed}
            id={support.fieldId("plaintextConfirmed")}
            onChange={(event) => {
              onChange({ plaintextConfirmed: event.target.checked });
              support.clearFieldError("plaintextConfirmed");
            }}
            ref={support.registerField("plaintextConfirmed")}
            type="checkbox"
          />
          <span>我了解 ws:// 连接不会加密传输内容</span>
          <FieldError
            id={support.errorId("plaintextConfirmed")}
            message={support.fieldErrors.plaintextConfirmed}
          />
        </label>
      ) : null}

      <div className={styles.twoColumns}>
        <label
          className={styles.field}
          htmlFor={support.fieldId("authentication")}
        >
          <span>认证方式</span>
          <select
            aria-describedby={
              [
                support.fieldErrors.authentication === undefined
                  ? undefined
                  : support.errorId("authentication"),
                support.fieldErrors.credential === undefined
                  ? undefined
                  : support.errorId("credential"),
              ]
                .filter(Boolean)
                .join(" ") || undefined
            }
            aria-invalid={
              support.fieldErrors.authentication !== undefined ||
              support.fieldErrors.credential !== undefined
            }
            id={support.fieldId("authentication")}
            onChange={(event) => {
              onChange({
                authentication: event.target.value as "none" | "bearer",
              });
              support.clearFieldError("authentication");
              support.clearFieldError("credential");
              support.clearFieldError("bearerToken");
            }}
            ref={support.registerField("authentication")}
            value={draft.authentication}
          >
            <option value="none">无认证</option>
            <option value="bearer">Bearer 令牌</option>
          </select>
          <FieldError
            id={support.errorId("authentication")}
            message={support.fieldErrors.authentication}
          />
        </label>

        <label
          className={styles.field}
          htmlFor={support.fieldId("connectTimeoutMs")}
        >
          <span>连接超时（毫秒）</span>
          <input
            aria-describedby={
              support.fieldErrors.connectTimeoutMs === undefined
                ? `${support.fieldId("connectTimeoutMs")}-help`
                : `${support.fieldId("connectTimeoutMs")}-help ${support.errorId("connectTimeoutMs")}`
            }
            aria-invalid={support.fieldErrors.connectTimeoutMs !== undefined}
            id={support.fieldId("connectTimeoutMs")}
            inputMode="numeric"
            max={120000}
            min={1000}
            onChange={(event) => {
              onChange({ connectTimeoutMs: event.target.value });
              support.clearFieldError("connectTimeoutMs");
            }}
            ref={support.registerField("connectTimeoutMs")}
            step={1000}
            type="number"
            value={draft.connectTimeoutMs}
          />
          <small id={`${support.fieldId("connectTimeoutMs")}-help`}>
            允许范围 1000–120000
          </small>
          <FieldError
            id={support.errorId("connectTimeoutMs")}
            message={support.fieldErrors.connectTimeoutMs}
          />
        </label>
      </div>

      {draft.authentication === "bearer" ? (
        <label
          className={styles.field}
          htmlFor={support.fieldId("bearerToken")}
        >
          <span>Bearer 令牌</span>
          <input
            aria-describedby={[
              `${support.fieldId("bearerToken")}-help`,
              support.fieldErrors.bearerToken === undefined
                ? undefined
                : support.errorId("bearerToken"),
              support.fieldErrors.credential === undefined
                ? undefined
                : support.errorId("credential"),
            ]
              .filter(Boolean)
              .join(" ")}
            aria-invalid={
              support.fieldErrors.bearerToken !== undefined ||
              support.fieldErrors.credential !== undefined
            }
            autoComplete="new-password"
            id={support.fieldId("bearerToken")}
            onChange={(event) => {
              onChange({ bearerToken: event.target.value });
              if (event.target.value.length > 0) {
                onBearerInput();
              }
              support.clearFieldError("bearerToken");
              support.clearFieldError("credential");
            }}
            ref={support.registerField("bearerToken")}
            spellCheck={false}
            type="password"
            value={draft.bearerToken}
          />
          <small id={`${support.fieldId("bearerToken")}-help`}>
            已保存令牌不会回填；身份范围不变时留空可保持原令牌
          </small>
          <FieldError
            id={support.errorId("bearerToken")}
            message={support.fieldErrors.bearerToken}
          />
        </label>
      ) : null}

      {credentialStatus}
      <FieldError
        id={support.errorId("credential")}
        message={support.fieldErrors.credential}
      />

      <KeyValueList
        field="nonSensitiveHeaders"
        help="名称和值分开填写；认证头、Cookie 和代理头不允许填写"
        label="普通请求头"
        namePlaceholder="X-Client-Name"
        onChange={(values) => onChange({ nonSensitiveHeaders: values })}
        support={support}
        valuePlaceholder="Codex Desktop"
        values={draft.nonSensitiveHeaders}
      />

      <div className={styles.twoColumns}>
        <label
          className={styles.field}
          htmlFor={support.fieldId("tlsCertificatePolicy")}
        >
          <span>TLS 证书策略</span>
          <select
            aria-describedby={
              support.fieldErrors.tlsCertificatePolicy === undefined
                ? `${support.fieldId("tlsCertificatePolicy")}-help`
                : `${support.fieldId("tlsCertificatePolicy")}-help ${support.errorId("tlsCertificatePolicy")}`
            }
            aria-invalid={
              support.fieldErrors.tlsCertificatePolicy !== undefined
            }
            disabled={isPlaintext}
            id={support.fieldId("tlsCertificatePolicy")}
            onChange={(event) => {
              onChange({
                tlsCertificatePolicy: event.target
                  .value as TlsCertificatePolicy,
              });
              support.clearFieldError("tlsCertificatePolicy");
            }}
            ref={support.registerField("tlsCertificatePolicy")}
            value={draft.tlsCertificatePolicy}
          >
            <option value="strict">严格校验证书</option>
            <option value="allowInvalidCertificate">允许无效证书</option>
          </select>
          <small id={`${support.fieldId("tlsCertificatePolicy")}-help`}>
            默认严格校验证书和主机名
          </small>
          <FieldError
            id={support.errorId("tlsCertificatePolicy")}
            message={support.fieldErrors.tlsCertificatePolicy}
          />
        </label>

        <div className={styles.fieldGroup}>
          <div className={styles.fieldGroupHeading}>
            <label htmlFor={support.fieldId("proxyId")}>连接路径</label>
            {onCreateProxy === undefined ? null : (
              <button
                className={styles.textButton}
                onClick={onCreateProxy}
                type="button"
              >
                新建代理
              </button>
            )}
          </div>
          <select
            aria-describedby={
              support.fieldErrors.proxyId === undefined
                ? undefined
                : support.errorId("proxyId")
            }
            aria-invalid={support.fieldErrors.proxyId !== undefined}
            id={support.fieldId("proxyId")}
            onChange={(event) => {
              onChange({ proxyId: event.target.value });
              support.clearFieldError("proxyId");
            }}
            ref={support.registerField("proxyId")}
            value={draft.proxyId}
          >
            <option value="">直连</option>
            {selectedProxyMissing ? (
              <option value={draft.proxyId}>不可用的已保存代理</option>
            ) : null}
            {proxies.map((proxy) => (
              <option key={proxy.proxyId} value={proxy.proxyId}>
                {proxy.name} · {proxyTypeLabel(proxy)}
              </option>
            ))}
          </select>
          <FieldError
            id={support.errorId("proxyId")}
            message={support.fieldErrors.proxyId}
          />
        </div>
      </div>

      {draft.tlsCertificatePolicy === "allowInvalidCertificate" ? (
        <div className={styles.riskNotice} role="alert">
          <strong>高风险 TLS 配置</strong>
          <span>
            保存后将不校验目标服务器证书和主机名，仅应在受控开发环境使用
          </span>
        </div>
      ) : null}

      {selectedProxyAllowsInvalidCertificate ? (
        <div className={styles.riskNotice} role="alert">
          <strong>高风险代理 TLS 配置</strong>
          <span>
            所选 HTTP CONNECT 代理允许无效证书，连接代理时不会校验证书和主机名
          </span>
        </div>
      ) : null}

      <div className={styles.proxySummary}>
        {selectedProxy === undefined ? (
          <span>
            {selectedProxyMissing
              ? "已保存的代理当前不可用"
              : "直连到远程服务器，不经过代理"}
          </span>
        ) : (
          <>
            <strong>{proxyTypeLabel(selectedProxy)}</strong>
            <span>{proxyEndpoint(selectedProxy)}</span>
            <span>
              最近测试：
              {selectedProxy.lastTest === undefined
                ? "尚未测试"
                : selectedProxy.lastTest.status === "succeeded"
                  ? "成功"
                  : "失败"}
            </span>
          </>
        )}
      </div>
    </section>
  );
}
