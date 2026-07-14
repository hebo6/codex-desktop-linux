import {
  ConfigurationContractError,
  normalizeCreateServerProfileRequest,
  normalizeSetServerCredentialRequest,
  type ProxyId,
  type ServerConfigurationInput,
  type ServerCredential,
  type ServerCredentialType,
  type ServerId,
  type ServerProfile,
  type TlsCertificatePolicy,
} from "../configuration";

export type ServerEditorMode =
  | { readonly type: "create" }
  | { readonly type: "edit"; readonly profile: ServerProfile };

export type ServerCredentialIntent =
  | { readonly type: "keep" }
  | { readonly type: "set"; readonly credential: ServerCredential }
  | {
      readonly type: "clear";
      readonly credentialType: ServerCredentialType;
    };

export interface ServerEditorSubmission {
  readonly name: string;
  readonly configuration: ServerConfigurationInput;
  readonly credentialIntent: ServerCredentialIntent;
}

export type ServerEditorTestState =
  | { readonly type: "testing" }
  | { readonly type: "cancelling" }
  | { readonly type: "cancelFailed"; readonly message: string }
  | { readonly type: "succeeded"; readonly message?: string }
  | {
      readonly type: "failed";
      readonly message: string;
      readonly sshHostKeyPrompt?: SshHostKeyPrompt;
    };

export type SshHostKeyPrompt =
  | {
      readonly kind: "unknown";
      readonly host: string;
      readonly port: number;
      readonly algorithm: string;
      readonly sha256Fingerprint: string;
    }
  | {
      readonly kind: "changed";
      readonly host: string;
      readonly port: number;
      readonly algorithm: string;
      readonly sha256Fingerprint: string;
      readonly expectedAlgorithm: string;
      readonly expectedSha256Fingerprint: string;
    };

export type ServerType = ServerConfigurationInput["type"];

export interface KeyValueDraft {
  readonly name: string;
  readonly value: string;
}

export interface LocalDraft {
  readonly executablePath: string;
  readonly arguments: readonly string[];
  readonly defaultWorkingDirectory: string;
  readonly nonSensitiveEnvironment: readonly KeyValueDraft[];
  readonly sensitiveEnvironment: readonly KeyValueDraft[];
}

export interface RemoteDraft {
  readonly url: string;
  readonly authentication: "none" | "bearer";
  readonly bearerToken: string;
  readonly nonSensitiveHeaders: readonly KeyValueDraft[];
  readonly connectTimeoutMs: string;
  readonly tlsCertificatePolicy: TlsCertificatePolicy;
  readonly plaintextConfirmed: boolean;
  readonly proxyId: string;
}

export interface ServerEditorDraft {
  readonly serverType: ServerType;
  readonly name: string;
  readonly local: LocalDraft;
  readonly remote: RemoteDraft;
  readonly clearExistingCredential: boolean;
}

export type ServerEditorFieldName =
  | "serverType"
  | "name"
  | "executablePath"
  | "arguments"
  | "defaultWorkingDirectory"
  | "nonSensitiveEnvironment"
  | "sensitiveEnvironment"
  | "url"
  | "authentication"
  | "bearerToken"
  | "nonSensitiveHeaders"
  | "connectTimeoutMs"
  | "tlsCertificatePolicy"
  | "plaintextConfirmed"
  | "proxyId"
  | "credential";

export type ServerEditorFieldErrors = Partial<
  Record<ServerEditorFieldName, string>
>;

export class ServerEditorFormError extends Error {
  constructor(
    readonly field: ServerEditorFieldName,
    message: string,
  ) {
    super(message);
    this.name = "ServerEditorFormError";
  }
}

const EMPTY_LOCAL_DRAFT: LocalDraft = {
  executablePath: "",
  arguments: [],
  defaultWorkingDirectory: "",
  nonSensitiveEnvironment: [],
  sensitiveEnvironment: [],
};

const EMPTY_REMOTE_DRAFT: RemoteDraft = {
  url: "",
  authentication: "none",
  bearerToken: "",
  nonSensitiveHeaders: [],
  connectTimeoutMs: "30000",
  tlsCertificatePolicy: "strict",
  plaintextConfirmed: false,
  proxyId: "",
};

// 仅用于复用凭据契约校验器，不会发送到后端
const CREDENTIAL_VALIDATION_SERVER_ID =
  "00000000-0000-4000-8000-000000000000" as ServerId;

function entries(values: Readonly<Record<string, string>>): KeyValueDraft[] {
  return Object.entries(values)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, value]) => ({ name, value }));
}

export function createServerEditorDraft(
  mode: ServerEditorMode,
): ServerEditorDraft {
  if (mode.type === "create") {
    return {
      serverType: "localStdio",
      name: "",
      local: { ...EMPTY_LOCAL_DRAFT },
      remote: { ...EMPTY_REMOTE_DRAFT },
      clearExistingCredential: false,
    };
  }

  const { profile } = mode;
  if (profile.configuration.type === "localStdio") {
    return {
      serverType: "localStdio",
      name: profile.name,
      local: {
        executablePath: profile.configuration.executablePath,
        arguments: [...profile.configuration.arguments],
        defaultWorkingDirectory:
          profile.configuration.defaultWorkingDirectory ?? "",
        nonSensitiveEnvironment: entries(
          profile.configuration.nonSensitiveEnvironment,
        ),
        sensitiveEnvironment: [],
      },
      remote: { ...EMPTY_REMOTE_DRAFT },
      clearExistingCredential: false,
    };
  }

  return {
    serverType: "remoteWebSocket",
    name: profile.name,
    local: { ...EMPTY_LOCAL_DRAFT },
    remote: {
      url: profile.configuration.url,
      authentication: profile.configuration.authentication,
      bearerToken: "",
      nonSensitiveHeaders: entries(profile.configuration.nonSensitiveHeaders),
      connectTimeoutMs: String(profile.configuration.connectTimeoutMs),
      tlsCertificatePolicy: profile.configuration.tlsCertificatePolicy,
      plaintextConfirmed: profile.configuration.plaintextConfirmed,
      proxyId: profile.configuration.proxyId ?? "",
    },
    clearExistingCredential: false,
  };
}

export function existingServerCredentialType(
  mode: ServerEditorMode,
): ServerCredentialType | undefined {
  if (mode.type !== "edit" || !mode.profile.credentialConfigured) {
    return undefined;
  }
  if (mode.profile.configuration.type === "localStdio") {
    return "sensitiveEnvironment";
  }
  return mode.profile.configuration.authentication === "bearer"
    ? "bearerToken"
    : undefined;
}

export function isPlaintextWebSocketUrl(value: string): boolean {
  try {
    return new URL(value).protocol === "ws:";
  } catch {
    return false;
  }
}

function keyValueRecord(
  values: readonly KeyValueDraft[],
  field: ServerEditorFieldName,
  label: string,
  caseInsensitiveNames = false,
): Readonly<Record<string, string>> {
  const result: [string, string][] = [];
  const names = new Set<string>();
  for (const [index, entry] of values.entries()) {
    const name = entry.name.trim();
    if (name.length === 0) {
      throw new ServerEditorFormError(
        field,
        `${label}第 ${index + 1} 项必须填写名称`,
      );
    }
    const comparisonName = caseInsensitiveNames ? name.toLowerCase() : name;
    if (names.has(comparisonName)) {
      throw new ServerEditorFormError(field, `${label}中存在重复名称“${name}”`);
    }
    names.add(comparisonName);
    result.push([name, entry.value]);
  }
  return Object.fromEntries(result);
}

function normalizedOrigin(value: string): string {
  const url = new URL(value);
  const port = url.port || (url.protocol === "ws:" ? "80" : "443");
  return `${url.protocol}//${url.hostname}:${port}`;
}

export function hasServerCredentialBindingChanged(
  profile: ServerProfile,
  configuration: ServerConfigurationInput,
): boolean {
  if (!profile.credentialConfigured) {
    return false;
  }
  const previous = profile.configuration;
  if (previous.type !== configuration.type) {
    return true;
  }
  if (previous.type === "localStdio" && configuration.type === "localStdio") {
    return (
      previous.executablePath !== configuration.executablePath ||
      Object.keys(configuration.nonSensitiveEnvironment ?? {}).some(
        (name) =>
          !Object.prototype.hasOwnProperty.call(
            previous.nonSensitiveEnvironment,
            name,
          ),
      )
    );
  }
  if (
    previous.type === "remoteWebSocket" &&
    configuration.type === "remoteWebSocket"
  ) {
    return (
      previous.authentication !== configuration.authentication ||
      normalizedOrigin(previous.url) !== normalizedOrigin(configuration.url)
    );
  }
  return true;
}

function buildCredentialIntent(
  mode: ServerEditorMode,
  draft: ServerEditorDraft,
  configuration: ServerConfigurationInput,
  nonSensitiveEnvironment: Readonly<Record<string, string>>,
): ServerCredentialIntent {
  const savedCredentialType = existingServerCredentialType(mode);
  let credential: ServerCredential | undefined;

  if (
    draft.serverType === "localStdio" &&
    draft.local.sensitiveEnvironment.length > 0
  ) {
    const values = keyValueRecord(
      draft.local.sensitiveEnvironment,
      "sensitiveEnvironment",
      "敏感环境变量",
    );
    const overlappingName = Object.keys(values).find((name) =>
      Object.prototype.hasOwnProperty.call(nonSensitiveEnvironment, name),
    );
    if (overlappingName !== undefined) {
      throw new ServerEditorFormError(
        "sensitiveEnvironment",
        `环境变量“${overlappingName}”不能同时设为普通和敏感变量`,
      );
    }
    credential = { type: "sensitiveEnvironment", values };
  } else if (
    draft.serverType === "remoteWebSocket" &&
    draft.remote.authentication === "bearer" &&
    draft.remote.bearerToken.length > 0
  ) {
    credential = { type: "bearerToken", value: draft.remote.bearerToken };
  }

  if (credential !== undefined) {
    const normalized = normalizeSetServerCredentialRequest({
      serverId: CREDENTIAL_VALIDATION_SERVER_ID,
      expectedVersion: 1,
      credential,
    }).credential;
    return { type: "set", credential: normalized };
  }

  if (draft.clearExistingCredential && savedCredentialType !== undefined) {
    return { type: "clear", credentialType: savedCredentialType };
  }

  const currentCredentialType =
    configuration.type === "localStdio"
      ? "sensitiveEnvironment"
      : configuration.authentication === "bearer"
        ? "bearerToken"
        : undefined;

  if (
    configuration.type === "remoteWebSocket" &&
    configuration.authentication === "bearer" &&
    savedCredentialType === undefined
  ) {
    throw new ServerEditorFormError(
      "bearerToken",
      "选择 Bearer 认证后必须填写令牌",
    );
  }

  if (
    savedCredentialType !== undefined &&
    savedCredentialType !== currentCredentialType
  ) {
    throw new ServerEditorFormError(
      "credential",
      "当前连接配置无法继续使用已保存凭据，请填写新凭据或先清除已保存凭据",
    );
  }

  if (
    savedCredentialType !== undefined &&
    mode.type === "edit" &&
    hasServerCredentialBindingChanged(mode.profile, configuration)
  ) {
    throw new ServerEditorFormError(
      "credential",
      "连接身份范围已经变化，请重新填写凭据或清除已保存凭据",
    );
  }

  return { type: "keep" };
}

export interface BuildServerEditorSubmissionOptions {
  readonly mode: ServerEditorMode;
  readonly draft: ServerEditorDraft;
  readonly availableProxyIds: ReadonlySet<string>;
}

export function buildServerEditorSubmission({
  mode,
  draft,
  availableProxyIds,
}: BuildServerEditorSubmissionOptions): ServerEditorSubmission {
  let configuration: ServerConfigurationInput;
  let nonSensitiveEnvironment: Readonly<Record<string, string>> = {};

  if (draft.serverType === "localStdio") {
    nonSensitiveEnvironment = keyValueRecord(
      draft.local.nonSensitiveEnvironment,
      "nonSensitiveEnvironment",
      "普通环境变量",
    );
    configuration = {
      type: "localStdio",
      executablePath: draft.local.executablePath,
      arguments: [...draft.local.arguments],
      ...(draft.local.defaultWorkingDirectory.length === 0
        ? {}
        : { defaultWorkingDirectory: draft.local.defaultWorkingDirectory }),
      nonSensitiveEnvironment,
    };
  } else {
    if (
      draft.remote.proxyId.length > 0 &&
      !availableProxyIds.has(draft.remote.proxyId)
    ) {
      throw new ServerEditorFormError(
        "proxyId",
        "已选择的代理不可用，请重新选择连接路径",
      );
    }
    configuration = {
      type: "remoteWebSocket",
      url: draft.remote.url,
      authentication: draft.remote.authentication,
      nonSensitiveHeaders: keyValueRecord(
        draft.remote.nonSensitiveHeaders,
        "nonSensitiveHeaders",
        "普通请求头",
        true,
      ),
      connectTimeoutMs: Number(draft.remote.connectTimeoutMs),
      tlsCertificatePolicy: draft.remote.tlsCertificatePolicy,
      plaintextConfirmed: isPlaintextWebSocketUrl(draft.remote.url)
        ? draft.remote.plaintextConfirmed
        : false,
      ...(draft.remote.proxyId.length === 0
        ? {}
        : { proxyId: draft.remote.proxyId as ProxyId }),
    };
  }

  const normalized = normalizeCreateServerProfileRequest({
    name: draft.name,
    configuration,
  });
  return {
    name: normalized.name,
    configuration: normalized.configuration,
    credentialIntent: buildCredentialIntent(
      mode,
      draft,
      normalized.configuration,
      nonSensitiveEnvironment,
    ),
  };
}

export function formErrorFromUnknown(error: unknown): ServerEditorFormError {
  if (error instanceof ServerEditorFormError) {
    return error;
  }
  if (!(error instanceof ConfigurationContractError)) {
    return new ServerEditorFormError("serverType", "无法验证服务器配置");
  }

  const message = error.message;
  if (message.includes("request.name")) {
    return new ServerEditorFormError(
      "name",
      "请输入有效的服务器名称，名称不能为空",
    );
  }
  if (message.includes("executablePath")) {
    return new ServerEditorFormError(
      "executablePath",
      "可执行文件路径必须是以 / 开头的 Linux 绝对路径",
    );
  }
  if (message.includes("defaultWorkingDirectory")) {
    return new ServerEditorFormError(
      "defaultWorkingDirectory",
      "默认工作目录必须是以 / 开头的 Linux 绝对路径",
    );
  }
  if (message.includes("arguments")) {
    return new ServerEditorFormError("arguments", "参数数量或长度超出允许范围");
  }
  if (message.includes("nonSensitiveEnvironment")) {
    return new ServerEditorFormError(
      "nonSensitiveEnvironment",
      "普通环境变量名称或值无效，疑似敏感的变量请填写到敏感环境变量",
    );
  }
  if (message.includes("nonSensitiveHeaders")) {
    return new ServerEditorFormError(
      "nonSensitiveHeaders",
      "普通请求头名称或值无效，认证信息不能放入普通请求头",
    );
  }
  if (message.includes("connectTimeoutMs")) {
    return new ServerEditorFormError(
      "connectTimeoutMs",
      "连接超时必须是 1000 到 120000 之间的整数毫秒数",
    );
  }
  if (message.includes("plaintext confirmation")) {
    return new ServerEditorFormError(
      "plaintextConfirmed",
      "使用 ws:// 前必须确认连接不会加密",
    );
  }
  if (message.includes("TLS policy")) {
    return new ServerEditorFormError(
      "tlsCertificatePolicy",
      "当前 URL 与 TLS 证书策略不兼容",
    );
  }
  if (message.includes("request.configuration.url")) {
    return new ServerEditorFormError(
      "url",
      "请输入有效的 ws:// 或 wss:// URL，地址中不能包含凭据或敏感查询参数",
    );
  }
  if (message.includes("request.credential")) {
    return new ServerEditorFormError(
      "credential",
      "凭据格式或长度无效，请检查后重试",
    );
  }
  if (message.includes("proxyId")) {
    return new ServerEditorFormError("proxyId", "请选择有效的连接路径");
  }
  return new ServerEditorFormError(
    "serverType",
    "服务器配置无效，请检查各字段",
  );
}
