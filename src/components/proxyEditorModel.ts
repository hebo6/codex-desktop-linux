import {
  ConfigurationContractError,
  normalizeCreateProxyProfileRequest,
  normalizeSetProxyCredentialRequest,
  type HttpProxyAuthentication,
  type ProxyConfigurationInput,
  type ProxyCredential,
  type ProxyCredentialType,
  type ProxyId,
  type ProxyProfile,
  type Socks5Authentication,
  type Socks5DnsResolution,
  type SshAuthenticationConfiguration,
  type TlsCertificatePolicy,
} from "../configuration";

export type ProxyEditorMode =
  | { readonly type: "create" }
  | { readonly type: "edit"; readonly profile: ProxyProfile };

export type ProxyType = ProxyConfigurationInput["type"];

export interface KeyValueDraft {
  readonly name: string;
  readonly value: string;
}

export interface HttpProxyDraft {
  readonly url: string;
  readonly authentication: HttpProxyAuthentication;
  readonly username: string;
  readonly secret: string;
  readonly nonSensitiveHeaders: readonly KeyValueDraft[];
  readonly connectTimeoutMs: string;
  readonly tlsCertificatePolicy: TlsCertificatePolicy;
}

export interface Socks5ProxyDraft {
  readonly host: string;
  readonly port: string;
  readonly authentication: Socks5Authentication;
  readonly username: string;
  readonly password: string;
  readonly dnsResolution: Socks5DnsResolution;
  readonly connectTimeoutMs: string;
}

export interface SshProxyDraft {
  readonly host: string;
  readonly port: string;
  readonly username: string;
  readonly authentication: SshAuthenticationConfiguration["type"];
  readonly privateKeyPath: string;
  readonly secret: string;
  readonly connectTimeoutMs: string;
  readonly keepAliveIntervalMs: string;
  readonly keepAliveMaxFailures: string;
}

export interface ProxyEditorDraft {
  readonly proxyType: ProxyType;
  readonly name: string;
  readonly httpConnect: HttpProxyDraft;
  readonly socks5: Socks5ProxyDraft;
  readonly ssh: SshProxyDraft;
  readonly clearExistingCredential: boolean;
}

export type ProxyCredentialIntent =
  | { readonly type: "keep" }
  | { readonly type: "set"; readonly credential: ProxyCredential }
  | { readonly type: "clear"; readonly credentialType: ProxyCredentialType };

export interface ProxyEditorSubmission {
  readonly name: string;
  readonly configuration: ProxyConfigurationInput;
  readonly credentialIntent: ProxyCredentialIntent;
  readonly sshHostKey?: ProxySshHostKeyDraft;
}

export interface ProxySshHostKeyDraft {
  readonly host: string;
  readonly port: number;
  readonly algorithm: string;
  readonly sha256Fingerprint: string;
}

export type ProxyEditorFieldName =
  | "proxyType"
  | "name"
  | "url"
  | "host"
  | "port"
  | "authentication"
  | "username"
  | "secret"
  | "privateKeyPath"
  | "nonSensitiveHeaders"
  | "dnsResolution"
  | "connectTimeoutMs"
  | "tlsCertificatePolicy"
  | "keepAliveIntervalMs"
  | "keepAliveMaxFailures"
  | "credential";

export class ProxyEditorFormError extends Error {
  constructor(readonly field: ProxyEditorFieldName, message: string) {
    super(message);
    this.name = "ProxyEditorFormError";
  }
}

const EMPTY_HTTP: HttpProxyDraft = {
  url: "",
  authentication: "none",
  username: "",
  secret: "",
  nonSensitiveHeaders: [],
  connectTimeoutMs: "30000",
  tlsCertificatePolicy: "strict",
};

const EMPTY_SOCKS5: Socks5ProxyDraft = {
  host: "",
  port: "1080",
  authentication: "none",
  username: "",
  password: "",
  dnsResolution: "proxy",
  connectTimeoutMs: "30000",
};

const EMPTY_SSH: SshProxyDraft = {
  host: "",
  port: "22",
  username: "",
  authentication: "agent",
  privateKeyPath: "",
  secret: "",
  connectTimeoutMs: "30000",
  keepAliveIntervalMs: "15000",
  keepAliveMaxFailures: "3",
};

const VALIDATION_PROXY_ID = "00000000-0000-4000-8000-000000000000" as ProxyId;

export function createProxyEditorDraft(mode: ProxyEditorMode): ProxyEditorDraft {
  if (mode.type === "create") {
    return {
      proxyType: "httpConnect",
      name: "",
      httpConnect: { ...EMPTY_HTTP },
      socks5: { ...EMPTY_SOCKS5 },
      ssh: { ...EMPTY_SSH },
      clearExistingCredential: false,
    };
  }

  const profile = mode.profile;
  const draft: ProxyEditorDraft = {
    proxyType: profile.configuration.type,
    name: profile.name,
    httpConnect: { ...EMPTY_HTTP },
    socks5: { ...EMPTY_SOCKS5 },
    ssh: { ...EMPTY_SSH },
    clearExistingCredential: false,
  };
  switch (profile.configuration.type) {
    case "httpConnect":
      return {
        ...draft,
        httpConnect: {
          url: profile.configuration.url,
          authentication: profile.configuration.authentication,
          username: profile.configuration.username ?? "",
          secret: "",
          nonSensitiveHeaders: entries(profile.configuration.nonSensitiveHeaders),
          connectTimeoutMs: String(profile.configuration.connectTimeoutMs),
          tlsCertificatePolicy: profile.configuration.tlsCertificatePolicy,
        },
      };
    case "socks5":
      return {
        ...draft,
        socks5: {
          host: profile.configuration.host,
          port: String(profile.configuration.port),
          authentication: profile.configuration.authentication,
          username: profile.configuration.username ?? "",
          password: "",
          dnsResolution: profile.configuration.dnsResolution,
          connectTimeoutMs: String(profile.configuration.connectTimeoutMs),
        },
      };
    case "ssh":
      return {
        ...draft,
        ssh: {
          host: profile.configuration.host,
          port: String(profile.configuration.port),
          username: profile.configuration.username,
          authentication: profile.configuration.authentication.type,
          privateKeyPath: profile.configuration.authentication.type === "privateKey"
            ? profile.configuration.authentication.privateKeyPath
            : "",
          secret: "",
          connectTimeoutMs: String(profile.configuration.connectTimeoutMs),
          keepAliveIntervalMs: String(profile.configuration.keepAliveIntervalMs),
          keepAliveMaxFailures: String(profile.configuration.keepAliveMaxFailures),
        },
      };
  }
}

export function existingProxyCredentialType(
  profile: ProxyProfile,
): ProxyCredentialType | undefined {
  if (!profile.credentialConfigured) return undefined;
  return credentialTypeForConfiguration(profile.configuration);
}

export function credentialTypeForConfiguration(
  configuration: ProxyConfigurationInput,
): ProxyCredentialType | undefined {
  switch (configuration.type) {
    case "httpConnect":
      return configuration.authentication === "basic"
        ? "httpBasicPassword"
        : configuration.authentication === "bearer"
          ? "httpBearerToken"
          : undefined;
    case "socks5":
      return configuration.authentication === "usernamePassword"
        ? "socks5Password"
        : undefined;
    case "ssh":
      return configuration.authentication.type === "privateKey"
        ? "sshPrivateKeyPassphrase"
        : configuration.authentication.type === "password"
          ? "sshPassword"
          : undefined;
  }
}

export function buildProxyEditorSubmission(
  mode: ProxyEditorMode,
  draft: ProxyEditorDraft,
  sshHostKey?: ProxySshHostKeyDraft,
): ProxyEditorSubmission {
  const configuration = buildConfiguration(draft);
  const normalized = normalizeCreateProxyProfileRequest({
    name: draft.name,
    configuration,
  });
  const normalizedHostKey = normalizeDraftHostKey(mode, normalized.configuration, sshHostKey);
  return {
    name: normalized.name,
    configuration: normalized.configuration,
    credentialIntent: buildCredentialIntent(mode, draft, normalized.configuration),
    ...(normalizedHostKey === undefined ? {} : { sshHostKey: normalizedHostKey }),
  };
}

function normalizeDraftHostKey(
  mode: ProxyEditorMode,
  configuration: ProxyConfigurationInput,
  sshHostKey: ProxySshHostKeyDraft | undefined,
): ProxySshHostKeyDraft | undefined {
  const stored = mode.type === "edit" ? mode.profile.sshHostKey : undefined;
  if (
    stored !== undefined &&
    (configuration.type !== "ssh" ||
      configuration.host !== stored.host ||
      (configuration.port ?? 22) !== stored.port)
  ) {
    throw new ProxyEditorFormError(
      "host",
      "更改 SSH 端点前必须先移除已保存的主机密钥",
    );
  }
  if (sshHostKey === undefined) return undefined;
  if (
    configuration.type !== "ssh" ||
    sshHostKey.host !== configuration.host ||
    sshHostKey.port !== (configuration.port ?? 22)
  ) {
    throw new ProxyEditorFormError("host", "SSH 主机密钥与当前端点不匹配");
  }
  return Object.freeze({ ...sshHostKey });
}

function buildConfiguration(draft: ProxyEditorDraft): ProxyConfigurationInput {
  switch (draft.proxyType) {
    case "httpConnect": {
      const value = draft.httpConnect;
      return {
        type: "httpConnect",
        url: value.url,
        authentication: value.authentication,
        ...(value.authentication === "basic" ? { username: value.username } : {}),
        nonSensitiveHeaders: keyValueRecord(value.nonSensitiveHeaders),
        connectTimeoutMs: Number(value.connectTimeoutMs),
        tlsCertificatePolicy: value.tlsCertificatePolicy,
      };
    }
    case "socks5": {
      const value = draft.socks5;
      return {
        type: "socks5",
        host: value.host,
        port: Number(value.port),
        authentication: value.authentication,
        ...(value.authentication === "usernamePassword" ? { username: value.username } : {}),
        dnsResolution: value.dnsResolution,
        connectTimeoutMs: Number(value.connectTimeoutMs),
      };
    }
    case "ssh": {
      const value = draft.ssh;
      const authentication: SshAuthenticationConfiguration = value.authentication === "privateKey"
        ? { type: "privateKey", privateKeyPath: value.privateKeyPath }
        : { type: value.authentication };
      return {
        type: "ssh",
        host: value.host,
        port: Number(value.port),
        username: value.username,
        authentication,
        connectTimeoutMs: Number(value.connectTimeoutMs),
        keepAliveIntervalMs: Number(value.keepAliveIntervalMs),
        keepAliveMaxFailures: Number(value.keepAliveMaxFailures),
      };
    }
  }
}

function buildCredentialIntent(
  mode: ProxyEditorMode,
  draft: ProxyEditorDraft,
  configuration: ProxyConfigurationInput,
): ProxyCredentialIntent {
  const requiredType = credentialTypeForConfiguration(configuration);
  const secret = selectedSecret(draft);
  if (secret.length > 0 && requiredType !== undefined) {
    const normalized = normalizeSetProxyCredentialRequest({
      proxyId: mode.type === "edit" ? mode.profile.proxyId : VALIDATION_PROXY_ID,
      expectedVersion: mode.type === "edit" ? mode.profile.version : 1,
      credential: { type: requiredType, value: secret },
    });
    return { type: "set", credential: normalized.credential };
  }

  const existingType = mode.type === "edit"
    ? existingProxyCredentialType(mode.profile)
    : undefined;
  const privateKeyWithoutPassphrase = requiredType === "sshPrivateKeyPassphrase";
  if (existingType === undefined) {
    if (requiredType !== undefined && !privateKeyWithoutPassphrase) {
      throw new ProxyEditorFormError("credential", "当前认证方式需要填写凭据");
    }
    return { type: "keep" };
  }
  if (draft.clearExistingCredential || existingType !== requiredType) {
    if (requiredType !== undefined && !privateKeyWithoutPassphrase) {
      throw new ProxyEditorFormError("credential", "更换认证方式时必须填写新的凭据");
    }
    return { type: "clear", credentialType: existingType };
  }
  return { type: "keep" };
}

function selectedSecret(draft: ProxyEditorDraft): string {
  switch (draft.proxyType) {
    case "httpConnect": return draft.httpConnect.secret;
    case "socks5": return draft.socks5.password;
    case "ssh": return draft.ssh.secret;
  }
}

function entries(values: Readonly<Record<string, string>>): KeyValueDraft[] {
  return Object.entries(values).map(([name, value]) => ({ name, value }));
}

function keyValueRecord(values: readonly KeyValueDraft[]): Readonly<Record<string, string>> {
  const output: Record<string, string> = {};
  for (const entry of values) {
    if (entry.name.length === 0 && entry.value.length === 0) continue;
    if (entry.name.length === 0 || Object.hasOwn(output, entry.name)) {
      throw new ProxyEditorFormError(
        "nonSensitiveHeaders",
        entry.name.length === 0 ? "请求头名称不能为空" : "请求头名称不能重复",
      );
    }
    output[entry.name] = entry.value;
  }
  return output;
}

export function proxyFormError(error: unknown): ProxyEditorFormError {
  if (error instanceof ProxyEditorFormError) return error;
  if (!(error instanceof ConfigurationContractError)) {
    return new ProxyEditorFormError("proxyType", "无法验证代理配置");
  }
  const message = error.message;
  if (message.includes("request.name")) return new ProxyEditorFormError("name", "请输入有效的代理名称");
  if (message.includes("request.configuration.url")) return new ProxyEditorFormError("url", "请输入有效的 http:// 或 https:// 代理 URL");
  if (message.includes("request.configuration.host")) return new ProxyEditorFormError("host", "请输入有效的代理主机名或 IP 地址");
  if (message.includes("request.configuration.port")) return new ProxyEditorFormError("port", "端口必须是 1 到 65535 之间的整数");
  if (message.includes("request.configuration.username")) return new ProxyEditorFormError("username", "请输入有效的用户名");
  if (message.includes("privateKeyPath")) return new ProxyEditorFormError("privateKeyPath", "私钥路径必须是 Linux 绝对路径");
  if (message.includes("nonSensitiveHeaders")) return new ProxyEditorFormError("nonSensitiveHeaders", "普通请求头无效，不能包含认证或 Cookie 字段");
  if (message.includes("connectTimeoutMs")) return new ProxyEditorFormError("connectTimeoutMs", "连接超时必须是 1000 到 120000 毫秒");
  if (message.includes("keepAliveIntervalMs")) return new ProxyEditorFormError("keepAliveIntervalMs", "SSH 保活间隔无效");
  if (message.includes("keepAliveMaxFailures")) return new ProxyEditorFormError("keepAliveMaxFailures", "SSH 保活失败次数无效");
  if (message.includes("credential")) return new ProxyEditorFormError("credential", "凭据格式或长度无效");
  return new ProxyEditorFormError("proxyType", "代理配置无效，请检查各字段");
}
