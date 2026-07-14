import type {
  ClearProxyCredentialRequest,
  ConfirmProxySshHostKeyRequest,
  ClearServerCredentialRequest,
  ConfigurationSnapshot,
  CreateProxyProfileRequest,
  CreateServerProfileRequest,
  DeleteProxyProfileRequest,
  DeleteServerProfileRequest,
  HttpConnectProxyConfiguration,
  HttpConnectProxyConfigurationInput,
  LocalStdioServerConfiguration,
  LocalStdioServerConfigurationInput,
  NonSensitiveValues,
  ProxyConfiguration,
  ProxyConfigurationInput,
  ProxyCredential,
  ProxyCredentialType,
  ProxyId,
  ProxyLastTest,
  ProxyProfile,
  RecordProxyTestRequest,
  RemoveProxySshHostKeyRequest,
  RemoteWebSocketServerConfiguration,
  RemoteWebSocketServerConfigurationInput,
  ServerConfiguration,
  ServerConfigurationInput,
  ServerCredential,
  ServerCredentialType,
  ServerId,
  ServerProfile,
  Socks5ProxyConfiguration,
  Socks5ProxyConfigurationInput,
  SensitiveEnvironmentValues,
  SshAuthenticationConfiguration,
  SshHostKeyRecord,
  SshProxyConfiguration,
  SshProxyConfigurationInput,
  SetProxyCredentialRequest,
  SetServerCredentialRequest,
  UpdateProxyProfileRequest,
  UpdateServerProfileRequest,
} from "./model";

const MAX_NAME_BYTES = 128;
const MAX_PATH_BYTES = 4 * 1024;
const MAX_ARGUMENT_COUNT = 128;
const MAX_ARGUMENT_BYTES = 4 * 1024;
const MAX_ENVIRONMENT_COUNT = 64;
const MAX_ENVIRONMENT_NAME_BYTES = 128;
const MAX_ENVIRONMENT_VALUE_BYTES = 8 * 1024;
const MAX_HTTP_BASIC_PASSWORD_BYTES = 5_882;
const MAX_BEARER_TOKEN_BYTES = 8_185;
const MAX_SOCKS5_PASSWORD_BYTES = 255;
const MAX_SSH_SECRET_BYTES = 8 * 1024;
const MAX_URL_BYTES = 4 * 1024;
const MAX_HEADER_COUNT = 32;
const MAX_HEADER_NAME_BYTES = 128;
const MAX_HEADER_VALUE_BYTES = 8 * 1024;
const MAX_HOST_BYTES = 253;
const MAX_USERNAME_BYTES = 255;
const MAX_ALGORITHM_BYTES = 128;
const MIN_CONNECT_TIMEOUT_MS = 1_000;
const MAX_CONNECT_TIMEOUT_MS = 120_000;
const MIN_KEEP_ALIVE_INTERVAL_MS = 1_000;
const MAX_KEEP_ALIVE_INTERVAL_MS = 300_000;
const MAX_KEEP_ALIVE_FAILURES = 10;
const DEFAULT_SSH_PORT = 22;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SSH_SHA256_FINGERPRINT_PATTERN =
  /^SHA256:[A-Za-z0-9+/]{42}[AQgw]$/u;
const HTTP_HEADER_NAME_PATTERN =
  /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/u;
const CONTROL_CHARACTER_PATTERN = /\p{Cc}/u;
const BEARER_TOKEN_PATTERN = /^[A-Za-z0-9.\-_~+/]+={0,}$/u;
const textEncoder = new TextEncoder();

const SERVER_CREDENTIAL_TYPES = [
  "sensitiveEnvironment",
  "bearerToken",
] as const satisfies readonly ServerCredentialType[];
const PROXY_CREDENTIAL_TYPES = [
  "httpBasicPassword",
  "httpBearerToken",
  "socks5Password",
  "sshPrivateKeyPassphrase",
  "sshPassword",
] as const satisfies readonly ProxyCredentialType[];

type UnknownRecord = Record<string, unknown>;

export class ConfigurationContractError extends Error {
  readonly code = "invalidConfigurationContract";

  constructor(path: string, problem: string) {
    super(`Invalid configuration contract at ${path}: ${problem}`);
    this.name = "ConfigurationContractError";
  }
}

function invalid(path: string, problem: string): never {
  throw new ConfigurationContractError(path, problem);
}

function byteLength(value: string): number {
  return textEncoder.encode(value).byteLength;
}

function expectRecord(value: unknown, path: string): UnknownRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return invalid(path, "expected an object");
  }
  return value as UnknownRecord;
}

function hasOwn(record: UnknownRecord, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function assertExactKeys(
  record: UnknownRecord,
  required: readonly string[],
  optional: readonly string[],
  path: string,
): void {
  const allowed = new Set([...required, ...optional]);
  for (const key of Reflect.ownKeys(record)) {
    if (typeof key !== "string" || !allowed.has(key)) {
      invalid(path, "contains an unknown field");
    }
  }
  for (const key of required) {
    if (!hasOwn(record, key)) {
      invalid(`${path}.${key}`, "is required");
    }
  }
}

function expectString(value: unknown, path: string): string {
  if (typeof value !== "string") {
    return invalid(path, "expected a string");
  }
  return value;
}

function expectBoolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") {
    return invalid(path, "expected a boolean");
  }
  return value;
}

function expectEnum<const Value extends string>(
  value: unknown,
  allowed: readonly Value[],
  path: string,
): Value {
  if (typeof value !== "string" || !allowed.includes(value as Value)) {
    return invalid(path, "contains an unsupported enum value");
  }
  return value as Value;
}

function expectSafeInteger(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    return invalid(path, "expected a safe integer");
  }
  return value;
}

function expectVersion(value: unknown, path: string): number {
  const version = expectSafeInteger(value, path);
  if (version <= 0) {
    return invalid(path, "expected a positive version");
  }
  return version;
}

function expectTimestamp(value: unknown, path: string): number {
  const timestamp = expectSafeInteger(value, path);
  if (timestamp < 0) {
    return invalid(path, "expected a non-negative Unix timestamp");
  }
  return timestamp;
}

function expectNonNegativeCount(value: unknown, path: string): number {
  const count = expectSafeInteger(value, path);
  if (count < 0) {
    return invalid(path, "expected a non-negative count");
  }
  return count;
}

function expectPort(value: unknown, path: string): number {
  const port = expectSafeInteger(value, path);
  if (port < 1 || port > 65_535) {
    return invalid(path, "expected a TCP port");
  }
  return port;
}

function expectServerId(value: unknown, path: string): ServerId {
  const identifier = expectString(value, path);
  if (!UUID_PATTERN.test(identifier)) {
    return invalid(path, "expected a canonical UUID");
  }
  return identifier as ServerId;
}

function expectProxyId(value: unknown, path: string): ProxyId {
  const identifier = expectString(value, path);
  if (!UUID_PATTERN.test(identifier)) {
    return invalid(path, "expected a canonical UUID");
  }
  return identifier as ProxyId;
}

function expectStringArray(value: unknown, path: string): string[] {
  if (!Array.isArray(value)) {
    return invalid(path, "expected an array");
  }
  const result: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.prototype.hasOwnProperty.call(value, index)) {
      invalid(`${path}[${index}]`, "array entries must not be sparse");
    }
    result.push(expectString(value[index], `${path}[${index}]`));
  }
  return result;
}

function expectStringMap(value: unknown, path: string): NonSensitiveValues {
  const record = expectRecord(value, path);
  const entries: [string, string][] = [];
  for (const key of Reflect.ownKeys(record)) {
    if (typeof key !== "string") {
      invalid(path, "contains a non-string key");
    }
    entries.push([key, expectString(record[key], `${path}.${key}`)]);
  }
  entries.sort(([left], [right]) => compareText(left, right));
  return Object.fromEntries(entries);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function foldAsciiCase(value: string): string {
  return value.replace(/[A-Z]/gu, (character) => character.toLowerCase());
}

function looksSensitiveIdentifier(name: string): boolean {
  const hasSensitivePart = name
    .split(/[^0-9A-Za-z]+/u)
    .filter((part) => part.length > 0)
    .some((part) =>
      [
        "auth",
        "authorization",
        "cookie",
        "credential",
        "credentials",
        "jwt",
        "key",
        "pat",
        "password",
        "passwd",
        "secret",
        "session",
        "token",
      ].includes(part.toLowerCase()),
    );
  if (hasSensitivePart) {
    return true;
  }
  const compact = [...name]
    .filter((character) => /[0-9A-Za-z]/u.test(character))
    .join("")
    .toLowerCase();
  return (
    [
      "authorization",
      "bearer",
      "cookie",
      "credential",
      "password",
      "passwd",
      "secret",
      "session",
      "token",
    ].some((marker) => compact.includes(marker)) ||
    ["apikey", "accesskey", "privatekey", "secretkey", "signingkey"].some(
      (marker) => compact.includes(marker),
    )
  );
}

function looksSensitiveEnvironmentName(name: string): boolean {
  return (
    name.toUpperCase() === "SSH_AUTH_SOCK" || looksSensitiveIdentifier(name)
  );
}

function validateName(value: string, path: string, normalized: boolean): string {
  const name = value.trim();
  if (
    name.length === 0 ||
    byteLength(name) > MAX_NAME_BYTES ||
    CONTROL_CHARACTER_PATTERN.test(name) ||
    (normalized && name !== value)
  ) {
    return invalid(path, "contains an invalid profile name");
  }
  return name;
}

function validateAbsolutePath(value: string, path: string): string {
  if (
    value.length === 0 ||
    !value.startsWith("/") ||
    byteLength(value) > MAX_PATH_BYTES ||
    value.includes("\0")
  ) {
    return invalid(path, "expected an absolute Linux path");
  }
  return value;
}

function validateArguments<Value extends readonly string[]>(
  value: Value,
  path: string,
): Value {
  if (
    value.length > MAX_ARGUMENT_COUNT ||
    value.some(
      (argument) =>
        byteLength(argument) > MAX_ARGUMENT_BYTES || argument.includes("\0"),
    )
  ) {
    return invalid(path, "contains invalid process arguments");
  }
  return value;
}

function validateEnvironment(
  value: NonSensitiveValues,
  path: string,
): NonSensitiveValues {
  const entries = Object.entries(value);
  if (entries.length > MAX_ENVIRONMENT_COUNT) {
    return invalid(path, "contains too many environment variables");
  }
  for (const [name, environmentValue] of entries) {
    if (
      !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name) ||
      byteLength(name) > MAX_ENVIRONMENT_NAME_BYTES ||
      looksSensitiveEnvironmentName(name) ||
      byteLength(environmentValue) > MAX_ENVIRONMENT_VALUE_BYTES ||
      environmentValue.includes("\0")
    ) {
      invalid(path, "contains an invalid non-sensitive environment variable");
    }
  }
  return value;
}

function normalizeSensitiveEnvironment(
  value: unknown,
  path: string,
): SensitiveEnvironmentValues {
  const record = expectRecord(value, path);
  const keys = Reflect.ownKeys(record);
  if (keys.length === 0 || keys.length > MAX_ENVIRONMENT_COUNT) {
    return invalid(path, "contains an invalid number of environment variables");
  }

  const entries: [string, string][] = [];
  for (const key of keys) {
    if (typeof key !== "string") {
      invalid(path, "contains a non-string environment variable name");
    }
    const environmentValue = expectString(record[key], `${path}.value`);
    if (
      !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key) ||
      byteLength(key) > MAX_ENVIRONMENT_NAME_BYTES ||
      byteLength(environmentValue) > MAX_ENVIRONMENT_VALUE_BYTES ||
      environmentValue.includes("\0")
    ) {
      invalid(path, "contains an invalid sensitive environment variable");
    }
    entries.push([key, environmentValue]);
  }
  entries.sort(([left], [right]) => compareText(left, right));
  return Object.fromEntries(entries);
}

function normalizeTextCredential(
  value: unknown,
  path: string,
  maxBytes: number,
): string {
  const credential = expectString(value, path);
  if (
    credential.length === 0 ||
    byteLength(credential) > maxBytes ||
    credential.includes("\0")
  ) {
    return invalid(path, "contains an invalid credential value");
  }
  return credential;
}

function normalizeBearerToken(value: unknown, path: string): string {
  const credential = expectString(value, path);
  if (
    byteLength(credential) > MAX_BEARER_TOKEN_BYTES ||
    !BEARER_TOKEN_PATTERN.test(credential)
  ) {
    return invalid(path, "contains an invalid bearer token");
  }
  return credential;
}

function normalizeServerCredential(
  value: unknown,
  path: string,
): ServerCredential {
  const record = expectRecord(value, path);
  const type = expectEnum(record.type, SERVER_CREDENTIAL_TYPES, `${path}.type`);
  if (type === "sensitiveEnvironment") {
    return {
      type,
      values: normalizeSensitiveEnvironment(record.values, `${path}.values`),
    };
  }
  return {
    type,
    value: normalizeBearerToken(record.value, `${path}.value`),
  };
}

function normalizeProxyCredential(
  value: unknown,
  path: string,
): ProxyCredential {
  const record = expectRecord(value, path);
  const type = expectEnum(record.type, PROXY_CREDENTIAL_TYPES, `${path}.type`);
  const maxBytes =
    type === "httpBasicPassword"
      ? MAX_HTTP_BASIC_PASSWORD_BYTES
      : type === "socks5Password"
        ? MAX_SOCKS5_PASSWORD_BYTES
        : MAX_SSH_SECRET_BYTES;
  return {
    type,
    value:
      type === "httpBearerToken"
        ? normalizeBearerToken(record.value, `${path}.value`)
        : normalizeTextCredential(record.value, `${path}.value`, maxBytes),
  };
}

type ConfigurableHeaderTransport = "webSocket" | "httpConnect";

function isReservedTransportHeader(
  name: string,
  transport: ConfigurableHeaderTransport,
): boolean {
  const normalized = name.toLowerCase();
  if (normalized.startsWith("sec-websocket-")) {
    return true;
  }
  if (transport === "webSocket") {
    return (
      [
        "connection",
        "content-length",
        "host",
        "transfer-encoding",
        "upgrade",
      ].includes(normalized) || normalized.startsWith("proxy-")
    );
  }
  return [
    "authorization",
    "connection",
    "content-length",
    "host",
    "proxy-authenticate",
    "proxy-authorization",
    "proxy-connection",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
  ].includes(normalized);
}

function validateHeaders(
  value: NonSensitiveValues,
  path: string,
  transport: ConfigurableHeaderTransport,
): NonSensitiveValues {
  const entries = Object.entries(value);
  if (entries.length > MAX_HEADER_COUNT) {
    return invalid(path, "contains too many headers");
  }
  const normalizedNames = new Set<string>();
  for (const [name, headerValue] of entries) {
    const normalizedName = name.toLowerCase();
    if (
      byteLength(name) > MAX_HEADER_NAME_BYTES ||
      !HTTP_HEADER_NAME_PATTERN.test(name) ||
      looksSensitiveIdentifier(name) ||
      isReservedTransportHeader(name, transport) ||
      normalizedNames.has(normalizedName) ||
      byteLength(headerValue) > MAX_HEADER_VALUE_BYTES ||
      [...headerValue].some((character) => {
        const codePoint = character.codePointAt(0);
        return (
          codePoint !== undefined &&
          ((codePoint < 0x20 && codePoint !== 0x09) || codePoint === 0x7f)
        );
      })
    ) {
      invalid(path, "contains an invalid non-sensitive header");
    }
    normalizedNames.add(normalizedName);
  }
  return value;
}

function validateConnectTimeout(value: number, path: string): number {
  if (
    !Number.isSafeInteger(value) ||
    value < MIN_CONNECT_TIMEOUT_MS ||
    value > MAX_CONNECT_TIMEOUT_MS
  ) {
    return invalid(path, "contains an invalid connection timeout");
  }
  return value;
}

function parseUrl(value: string, path: string): URL {
  if (value.length === 0 || byteLength(value) > MAX_URL_BYTES) {
    return invalid(path, "contains an invalid URL");
  }
  try {
    return new URL(value);
  } catch {
    return invalid(path, "contains an invalid URL");
  }
}

function validateWebSocketUrl(
  value: string,
  plaintextConfirmed: boolean,
  tlsPolicy: "strict" | "allowInvalidCertificate",
  path: string,
): string {
  const url = parseUrl(value, path);
  const isPlaintext = url.protocol === "ws:";
  if (
    (!isPlaintext && url.protocol !== "wss:") ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.hostname.length === 0 ||
    value.includes("#") ||
    [...url.searchParams.keys()].some(looksSensitiveIdentifier)
  ) {
    return invalid(path, "contains an invalid WebSocket URL");
  }
  if (isPlaintext !== plaintextConfirmed) {
    return invalid(path, "has an invalid plaintext confirmation");
  }
  if (isPlaintext && tlsPolicy !== "strict") {
    return invalid(path, "has an invalid TLS policy");
  }
  return value;
}

function validateHttpProxyUrl(
  value: string,
  tlsPolicy: "strict" | "allowInvalidCertificate",
  path: string,
): string {
  const url = parseUrl(value, path);
  const isTls = url.protocol === "https:";
  if (
    (!isTls && url.protocol !== "http:") ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.hostname.length === 0 ||
    (url.pathname !== "" && url.pathname !== "/") ||
    value.includes("?") ||
    value.includes("#")
  ) {
    return invalid(path, "contains an invalid HTTP proxy URL");
  }
  if (!isTls && tlsPolicy !== "strict") {
    return invalid(path, "has an invalid TLS policy");
  }
  return value;
}

function validateHost(value: string, path: string): string {
  if (
    value.length === 0 ||
    byteLength(value) > MAX_HOST_BYTES ||
    CONTROL_CHARACTER_PATTERN.test(value) ||
    /[\s/?#@\\]/u.test(value)
  ) {
    return invalid(path, "contains an invalid proxy host");
  }
  try {
    const isBracketed = value.startsWith("[") && value.endsWith("]");
    const authority = isBracketed
      ? value
      : value.includes(":")
        ? `[${value}]`
        : value;
    const parsed = new URL(`http://${authority}/`);
    const normalizedHostname = parsed.hostname.replace(/^\[|\]$/gu, "");
    if (
      normalizedHostname.length === 0 ||
      byteLength(normalizedHostname) > MAX_HOST_BYTES
    ) {
      return invalid(path, "contains an invalid proxy host");
    }
  } catch {
    return invalid(path, "contains an invalid proxy host");
  }
  return value;
}

function validateUsername(value: string, path: string): string {
  if (
    value.trim().length === 0 ||
    byteLength(value) > MAX_USERNAME_BYTES ||
    CONTROL_CHARACTER_PATTERN.test(value)
  ) {
    return invalid(path, "contains an invalid username");
  }
  return value;
}

function validateOptionalUsername(
  required: boolean,
  value: string | undefined,
  path: string,
): string | undefined {
  if (required) {
    if (value === undefined) {
      return invalid(path, "is required by the authentication type");
    }
    return validateUsername(value, path);
  }
  if (value !== undefined) {
    return invalid(path, "must be omitted for this authentication type");
  }
  return undefined;
}

function validateHttpProxyUsername(
  authentication: "none" | "basic" | "bearer",
  value: string | undefined,
  path: string,
): string | undefined {
  const username = validateOptionalUsername(
    authentication === "basic",
    value,
    path,
  );
  if (username?.includes(":")) {
    return invalid(path, "must not contain a colon for Basic authentication");
  }
  return username;
}

function parseTlsPolicy(value: unknown, path: string) {
  return expectEnum(value, ["strict", "allowInvalidCertificate"], path);
}

function optionalString(
  record: UnknownRecord,
  key: string,
  path: string,
): string | undefined {
  return hasOwn(record, key)
    ? expectString(record[key], `${path}.${key}`)
    : undefined;
}

function optionalProxyId(
  record: UnknownRecord,
  key: string,
  path: string,
): ProxyId | undefined {
  return hasOwn(record, key)
    ? expectProxyId(record[key], `${path}.${key}`)
    : undefined;
}

function expectArray<Value>(
  value: unknown,
  path: string,
  parse: (entry: unknown, path: string) => Value,
): readonly Value[] {
  if (!Array.isArray(value)) {
    return invalid(path, "expected an array");
  }
  const result: Value[] = [];
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.prototype.hasOwnProperty.call(value, index)) {
      invalid(`${path}[${index}]`, "array entries must not be sparse");
    }
    result.push(parse(value[index], `${path}[${index}]`));
  }
  return result;
}

function parseSshAuthentication(
  value: unknown,
  path: string,
): SshAuthenticationConfiguration {
  const record = expectRecord(value, path);
  const type = expectEnum(
    record.type,
    ["agent", "privateKey", "password"],
    `${path}.type`,
  );
  if (type === "privateKey") {
    assertExactKeys(record, ["type", "privateKeyPath"], [], path);
    return {
      type,
      privateKeyPath: validateAbsolutePath(
        expectString(record.privateKeyPath, `${path}.privateKeyPath`),
        `${path}.privateKeyPath`,
      ),
    };
  }
  assertExactKeys(record, ["type"], [], path);
  return { type };
}

export function parseServerConfiguration(
  value: unknown,
  path = "server.configuration",
): ServerConfiguration {
  const record = expectRecord(value, path);
  const type = expectEnum(
    record.type,
    ["localStdio", "remoteWebSocket"],
    `${path}.type`,
  );
  if (type === "localStdio") {
    assertExactKeys(
      record,
      ["type", "executablePath", "arguments", "nonSensitiveEnvironment"],
      ["defaultWorkingDirectory"],
      path,
    );
    const defaultWorkingDirectory = optionalString(
      record,
      "defaultWorkingDirectory",
      path,
    );
    const configuration: LocalStdioServerConfiguration = {
      type,
      executablePath: validateAbsolutePath(
        expectString(record.executablePath, `${path}.executablePath`),
        `${path}.executablePath`,
      ),
      arguments: validateArguments(
        expectStringArray(record.arguments, `${path}.arguments`),
        `${path}.arguments`,
      ),
      ...(defaultWorkingDirectory === undefined
        ? {}
        : {
            defaultWorkingDirectory: validateAbsolutePath(
              defaultWorkingDirectory,
              `${path}.defaultWorkingDirectory`,
            ),
          }),
      nonSensitiveEnvironment: validateEnvironment(
        expectStringMap(
          record.nonSensitiveEnvironment,
          `${path}.nonSensitiveEnvironment`,
        ),
        `${path}.nonSensitiveEnvironment`,
      ),
    };
    return configuration;
  }

  assertExactKeys(
    record,
    [
      "type",
      "url",
      "authentication",
      "nonSensitiveHeaders",
      "connectTimeoutMs",
      "tlsCertificatePolicy",
      "plaintextConfirmed",
    ],
    ["proxyId"],
    path,
  );
  const tlsCertificatePolicy = parseTlsPolicy(
    record.tlsCertificatePolicy,
    `${path}.tlsCertificatePolicy`,
  );
  const plaintextConfirmed = expectBoolean(
    record.plaintextConfirmed,
    `${path}.plaintextConfirmed`,
  );
  const proxyId = optionalProxyId(record, "proxyId", path);
  const configuration: RemoteWebSocketServerConfiguration = {
    type,
    url: validateWebSocketUrl(
      expectString(record.url, `${path}.url`),
      plaintextConfirmed,
      tlsCertificatePolicy,
      `${path}.url`,
    ),
    authentication: expectEnum(
      record.authentication,
      ["none", "bearer"],
      `${path}.authentication`,
    ),
    nonSensitiveHeaders: validateHeaders(
      expectStringMap(
        record.nonSensitiveHeaders,
        `${path}.nonSensitiveHeaders`,
      ),
      `${path}.nonSensitiveHeaders`,
      "webSocket",
    ),
    connectTimeoutMs: validateConnectTimeout(
      expectSafeInteger(record.connectTimeoutMs, `${path}.connectTimeoutMs`),
      `${path}.connectTimeoutMs`,
    ),
    tlsCertificatePolicy,
    plaintextConfirmed,
    ...(proxyId === undefined ? {} : { proxyId }),
  };
  return configuration;
}

export function parseServerProfile(
  value: unknown,
  path = "server",
): ServerProfile {
  const record = expectRecord(value, path);
  assertExactKeys(
    record,
    [
      "serverId",
      "name",
      "version",
      "configuration",
      "credentialConfigured",
      "activeWindowCount",
      "createdAtMs",
      "updatedAtMs",
    ],
    ["lastUsedAtMs"],
    path,
  );
  const lastUsedAtMs = hasOwn(record, "lastUsedAtMs")
    ? expectTimestamp(record.lastUsedAtMs, `${path}.lastUsedAtMs`)
    : undefined;
  const createdAtMs = expectTimestamp(
    record.createdAtMs,
    `${path}.createdAtMs`,
  );
  const updatedAtMs = expectTimestamp(
    record.updatedAtMs,
    `${path}.updatedAtMs`,
  );
  if (updatedAtMs < createdAtMs) {
    invalid(`${path}.updatedAtMs`, "must not precede creation time");
  }
  const configuration = parseServerConfiguration(
    record.configuration,
    `${path}.configuration`,
  );
  const credentialConfigured = expectBoolean(
    record.credentialConfigured,
    `${path}.credentialConfigured`,
  );
  if (
    credentialConfigured &&
    configuration.type === "remoteWebSocket" &&
    configuration.authentication === "none"
  ) {
    invalid(
      `${path}.credentialConfigured`,
      "cannot be true when server authentication is disabled",
    );
  }
  return {
    serverId: expectServerId(record.serverId, `${path}.serverId`),
    name: validateName(expectString(record.name, `${path}.name`), `${path}.name`, true),
    version: expectVersion(record.version, `${path}.version`),
    configuration,
    credentialConfigured,
    activeWindowCount: expectNonNegativeCount(
      record.activeWindowCount,
      `${path}.activeWindowCount`,
    ),
    createdAtMs,
    updatedAtMs,
    ...(lastUsedAtMs === undefined ? {} : { lastUsedAtMs }),
  };
}

export function parseProxyConfiguration(
  value: unknown,
  path = "proxy.configuration",
): ProxyConfiguration {
  const record = expectRecord(value, path);
  const type = expectEnum(
    record.type,
    ["httpConnect", "socks5", "ssh"],
    `${path}.type`,
  );

  if (type === "httpConnect") {
    assertExactKeys(
      record,
      [
        "type",
        "url",
        "authentication",
        "nonSensitiveHeaders",
        "connectTimeoutMs",
        "tlsCertificatePolicy",
      ],
      ["username"],
      path,
    );
    const authentication = expectEnum(
      record.authentication,
      ["none", "basic", "bearer"],
      `${path}.authentication`,
    );
    const username = validateHttpProxyUsername(
      authentication,
      optionalString(record, "username", path),
      `${path}.username`,
    );
    const tlsCertificatePolicy = parseTlsPolicy(
      record.tlsCertificatePolicy,
      `${path}.tlsCertificatePolicy`,
    );
    const configuration: HttpConnectProxyConfiguration = {
      type,
      url: validateHttpProxyUrl(
        expectString(record.url, `${path}.url`),
        tlsCertificatePolicy,
        `${path}.url`,
      ),
      authentication,
      ...(username === undefined ? {} : { username }),
      nonSensitiveHeaders: validateHeaders(
        expectStringMap(
          record.nonSensitiveHeaders,
          `${path}.nonSensitiveHeaders`,
        ),
        `${path}.nonSensitiveHeaders`,
        "httpConnect",
      ),
      connectTimeoutMs: validateConnectTimeout(
        expectSafeInteger(record.connectTimeoutMs, `${path}.connectTimeoutMs`),
        `${path}.connectTimeoutMs`,
      ),
      tlsCertificatePolicy,
    };
    return configuration;
  }

  if (type === "socks5") {
    assertExactKeys(
      record,
      [
        "type",
        "host",
        "port",
        "authentication",
        "dnsResolution",
        "connectTimeoutMs",
      ],
      ["username"],
      path,
    );
    const authentication = expectEnum(
      record.authentication,
      ["none", "usernamePassword"],
      `${path}.authentication`,
    );
    const username = validateOptionalUsername(
      authentication === "usernamePassword",
      optionalString(record, "username", path),
      `${path}.username`,
    );
    const configuration: Socks5ProxyConfiguration = {
      type,
      host: validateHost(
        expectString(record.host, `${path}.host`),
        `${path}.host`,
      ),
      port: expectPort(record.port, `${path}.port`),
      authentication,
      ...(username === undefined ? {} : { username }),
      dnsResolution: expectEnum(
        record.dnsResolution,
        ["proxy", "local"],
        `${path}.dnsResolution`,
      ),
      connectTimeoutMs: validateConnectTimeout(
        expectSafeInteger(record.connectTimeoutMs, `${path}.connectTimeoutMs`),
        `${path}.connectTimeoutMs`,
      ),
    };
    return configuration;
  }

  assertExactKeys(
    record,
    [
      "type",
      "host",
      "port",
      "username",
      "authentication",
      "connectTimeoutMs",
      "keepAliveIntervalMs",
      "keepAliveMaxFailures",
    ],
    [],
    path,
  );
  const keepAliveIntervalMs = expectSafeInteger(
    record.keepAliveIntervalMs,
    `${path}.keepAliveIntervalMs`,
  );
  if (
    keepAliveIntervalMs < MIN_KEEP_ALIVE_INTERVAL_MS ||
    keepAliveIntervalMs > MAX_KEEP_ALIVE_INTERVAL_MS
  ) {
    invalid(`${path}.keepAliveIntervalMs`, "contains an invalid keep-alive interval");
  }
  const keepAliveMaxFailures = expectSafeInteger(
    record.keepAliveMaxFailures,
    `${path}.keepAliveMaxFailures`,
  );
  if (
    keepAliveMaxFailures < 1 ||
    keepAliveMaxFailures > MAX_KEEP_ALIVE_FAILURES
  ) {
    invalid(`${path}.keepAliveMaxFailures`, "contains an invalid keep-alive failure count");
  }
  const configuration: SshProxyConfiguration = {
    type,
    host: validateHost(
      expectString(record.host, `${path}.host`),
      `${path}.host`,
    ),
    port: expectPort(record.port, `${path}.port`),
    username: validateUsername(
      expectString(record.username, `${path}.username`),
      `${path}.username`,
    ),
    authentication: parseSshAuthentication(
      record.authentication,
      `${path}.authentication`,
    ),
    connectTimeoutMs: validateConnectTimeout(
      expectSafeInteger(record.connectTimeoutMs, `${path}.connectTimeoutMs`),
      `${path}.connectTimeoutMs`,
    ),
    keepAliveIntervalMs,
    keepAliveMaxFailures,
  };
  return configuration;
}

function parseSshHostKeyRecord(value: unknown, path: string): SshHostKeyRecord {
  const record = expectRecord(value, path);
  assertExactKeys(
    record,
    [
      "host",
      "port",
      "algorithm",
      "sha256Fingerprint",
      "confirmedAtMs",
    ],
    [],
    path,
  );
  const algorithm = expectString(record.algorithm, `${path}.algorithm`);
  if (
    algorithm.trim().length === 0 ||
    byteLength(algorithm) > MAX_ALGORITHM_BYTES ||
    CONTROL_CHARACTER_PATTERN.test(algorithm)
  ) {
    invalid(`${path}.algorithm`, "contains an invalid SSH host-key algorithm");
  }
  const sha256Fingerprint = expectString(
    record.sha256Fingerprint,
    `${path}.sha256Fingerprint`,
  );
  if (!SSH_SHA256_FINGERPRINT_PATTERN.test(sha256Fingerprint)) {
    invalid(`${path}.sha256Fingerprint`, "contains an invalid SHA256 fingerprint");
  }
  return {
    host: validateHost(
      expectString(record.host, `${path}.host`),
      `${path}.host`,
    ),
    port: expectPort(record.port, `${path}.port`),
    algorithm,
    sha256Fingerprint,
    confirmedAtMs: expectTimestamp(record.confirmedAtMs, `${path}.confirmedAtMs`),
  };
}

function parseProxyLastTest(value: unknown, path: string): ProxyLastTest {
  const record = expectRecord(value, path);
  assertExactKeys(record, ["status", "testedAtMs"], [], path);
  return {
    status: expectEnum(
      record.status,
      ["succeeded", "failed"],
      `${path}.status`,
    ),
    testedAtMs: expectTimestamp(record.testedAtMs, `${path}.testedAtMs`),
  };
}

export function parseProxyProfile(
  value: unknown,
  path = "proxy",
): ProxyProfile {
  const record = expectRecord(value, path);
  assertExactKeys(
    record,
    [
      "proxyId",
      "name",
      "version",
      "configuration",
      "credentialConfigured",
      "referencedServerCount",
      "createdAtMs",
      "updatedAtMs",
    ],
    ["sshHostKey", "lastTest"],
    path,
  );
  const sshHostKey = hasOwn(record, "sshHostKey")
    ? parseSshHostKeyRecord(record.sshHostKey, `${path}.sshHostKey`)
    : undefined;
  const lastTest = hasOwn(record, "lastTest")
    ? parseProxyLastTest(record.lastTest, `${path}.lastTest`)
    : undefined;
  const configuration = parseProxyConfiguration(
    record.configuration,
    `${path}.configuration`,
  );
  if (sshHostKey !== undefined) {
    if (configuration.type !== "ssh") {
      invalid(`${path}.sshHostKey`, "is only valid for an SSH proxy");
    }
    if (
      sshHostKey.host !== configuration.host ||
      sshHostKey.port !== configuration.port
    ) {
      invalid(`${path}.sshHostKey`, "does not match the SSH proxy endpoint");
    }
  }
  const createdAtMs = expectTimestamp(
    record.createdAtMs,
    `${path}.createdAtMs`,
  );
  const updatedAtMs = expectTimestamp(
    record.updatedAtMs,
    `${path}.updatedAtMs`,
  );
  if (updatedAtMs < createdAtMs) {
    invalid(`${path}.updatedAtMs`, "must not precede creation time");
  }
  const credentialConfigured = expectBoolean(
    record.credentialConfigured,
    `${path}.credentialConfigured`,
  );
  const authenticationDisabled =
    (configuration.type === "httpConnect" &&
      configuration.authentication === "none") ||
    (configuration.type === "socks5" &&
      configuration.authentication === "none") ||
    (configuration.type === "ssh" &&
      configuration.authentication.type === "agent");
  if (credentialConfigured && authenticationDisabled) {
    invalid(
      `${path}.credentialConfigured`,
      "cannot be true when proxy authentication has no stored credential",
    );
  }
  return {
    proxyId: expectProxyId(record.proxyId, `${path}.proxyId`),
    name: validateName(expectString(record.name, `${path}.name`), `${path}.name`, true),
    version: expectVersion(record.version, `${path}.version`),
    configuration,
    credentialConfigured,
    ...(sshHostKey === undefined ? {} : { sshHostKey }),
    ...(lastTest === undefined ? {} : { lastTest }),
    referencedServerCount: expectNonNegativeCount(
      record.referencedServerCount,
      `${path}.referencedServerCount`,
    ),
    createdAtMs,
    updatedAtMs,
  };
}

export function parseConfigurationSnapshot(
  value: unknown,
): ConfigurationSnapshot {
  const record = expectRecord(value, "configurationSnapshot");
  assertExactKeys(record, ["servers", "proxies"], [], "configurationSnapshot");
  const servers = expectArray(
    record.servers,
    "configurationSnapshot.servers",
    parseServerProfile,
  );
  const proxies = expectArray(
    record.proxies,
    "configurationSnapshot.proxies",
    parseProxyProfile,
  );
  const serverIds = new Set<ServerId>();
  const serverNames = new Set<string>();
  for (const server of servers) {
    if (serverIds.has(server.serverId)) {
      invalid("configurationSnapshot.servers", "contains a duplicate serverId");
    }
    serverIds.add(server.serverId);
    const normalizedName = foldAsciiCase(server.name);
    if (serverNames.has(normalizedName)) {
      invalid("configurationSnapshot.servers", "contains a duplicate server name");
    }
    serverNames.add(normalizedName);
  }
  const proxyIds = new Set<ProxyId>();
  const proxyNames = new Set<string>();
  const actualReferenceCounts = new Map<ProxyId, number>();
  for (const proxy of proxies) {
    if (proxyIds.has(proxy.proxyId)) {
      invalid("configurationSnapshot.proxies", "contains a duplicate proxyId");
    }
    proxyIds.add(proxy.proxyId);
    const normalizedName = foldAsciiCase(proxy.name);
    if (proxyNames.has(normalizedName)) {
      invalid("configurationSnapshot.proxies", "contains a duplicate proxy name");
    }
    proxyNames.add(normalizedName);
    actualReferenceCounts.set(proxy.proxyId, 0);
  }
  for (const server of servers) {
    if (
      server.configuration.type !== "remoteWebSocket" ||
      server.configuration.proxyId === undefined
    ) {
      continue;
    }
    const proxyId = server.configuration.proxyId;
    const currentCount = actualReferenceCounts.get(proxyId);
    if (currentCount === undefined) {
      invalid(
        "configurationSnapshot.servers",
        "references an unknown proxyId",
      );
    }
    actualReferenceCounts.set(proxyId, currentCount + 1);
  }
  for (const proxy of proxies) {
    if (
      proxy.referencedServerCount !== actualReferenceCounts.get(proxy.proxyId)
    ) {
      invalid(
        "configurationSnapshot.proxies",
        "contains an inconsistent referencedServerCount",
      );
    }
  }
  return { servers, proxies };
}

export function parseEmptyConfigurationResponse(value: unknown): void {
  if (value !== null) {
    invalid("configurationResponse", "expected an empty null response");
  }
}

function inputOptionalString(
  record: UnknownRecord,
  key: string,
  path: string,
): string | undefined {
  const value = record[key];
  return value === undefined
    ? undefined
    : expectString(value, `${path}.${key}`);
}

function inputOptionalProxyId(
  record: UnknownRecord,
  key: string,
  path: string,
): ProxyId | undefined {
  const value = record[key];
  return value === undefined
    ? undefined
    : expectProxyId(value, `${path}.${key}`);
}

function inputStringMap(
  record: UnknownRecord,
  key: string,
  path: string,
): NonSensitiveValues {
  const value = record[key];
  return value === undefined
    ? {}
    : expectStringMap(value, `${path}.${key}`);
}

function normalizeSshAuthenticationInput(
  value: unknown,
  path: string,
): SshAuthenticationConfiguration {
  const record = expectRecord(value, path);
  const type = expectEnum(
    record.type,
    ["agent", "privateKey", "password"],
    `${path}.type`,
  );
  if (type === "privateKey") {
    return {
      type,
      privateKeyPath: validateAbsolutePath(
        expectString(record.privateKeyPath, `${path}.privateKeyPath`),
        `${path}.privateKeyPath`,
      ),
    };
  }
  return { type };
}

export function normalizeServerConfigurationInput(
  value: ServerConfigurationInput,
  path = "request.configuration",
): ServerConfigurationInput {
  const record = expectRecord(value, path);
  const type = expectEnum(
    record.type,
    ["localStdio", "remoteWebSocket"],
    `${path}.type`,
  );
  if (type === "localStdio") {
    const defaultWorkingDirectory = inputOptionalString(
      record,
      "defaultWorkingDirectory",
      path,
    );
    const configuration: LocalStdioServerConfigurationInput = {
      type,
      executablePath: validateAbsolutePath(
        expectString(record.executablePath, `${path}.executablePath`),
        `${path}.executablePath`,
      ),
      arguments: validateArguments(
        expectStringArray(record.arguments, `${path}.arguments`),
        `${path}.arguments`,
      ),
      ...(defaultWorkingDirectory === undefined
        ? {}
        : {
            defaultWorkingDirectory: validateAbsolutePath(
              defaultWorkingDirectory,
              `${path}.defaultWorkingDirectory`,
            ),
          }),
      nonSensitiveEnvironment: validateEnvironment(
        inputStringMap(record, "nonSensitiveEnvironment", path),
        `${path}.nonSensitiveEnvironment`,
      ),
    };
    return configuration;
  }

  const tlsCertificatePolicy = parseTlsPolicy(
    record.tlsCertificatePolicy,
    `${path}.tlsCertificatePolicy`,
  );
  const plaintextConfirmed = expectBoolean(
    record.plaintextConfirmed,
    `${path}.plaintextConfirmed`,
  );
  const proxyId = inputOptionalProxyId(record, "proxyId", path);
  const configuration: RemoteWebSocketServerConfigurationInput = {
    type,
    url: validateWebSocketUrl(
      expectString(record.url, `${path}.url`),
      plaintextConfirmed,
      tlsCertificatePolicy,
      `${path}.url`,
    ),
    authentication: expectEnum(
      record.authentication,
      ["none", "bearer"],
      `${path}.authentication`,
    ),
    nonSensitiveHeaders: validateHeaders(
      inputStringMap(record, "nonSensitiveHeaders", path),
      `${path}.nonSensitiveHeaders`,
      "webSocket",
    ),
    connectTimeoutMs: validateConnectTimeout(
      expectSafeInteger(record.connectTimeoutMs, `${path}.connectTimeoutMs`),
      `${path}.connectTimeoutMs`,
    ),
    tlsCertificatePolicy,
    plaintextConfirmed,
    ...(proxyId === undefined ? {} : { proxyId }),
  };
  return configuration;
}

export function normalizeProxyConfigurationInput(
  value: ProxyConfigurationInput,
  path = "request.configuration",
): ProxyConfigurationInput {
  const record = expectRecord(value, path);
  const type = expectEnum(
    record.type,
    ["httpConnect", "socks5", "ssh"],
    `${path}.type`,
  );
  if (type === "httpConnect") {
    const authentication = expectEnum(
      record.authentication,
      ["none", "basic", "bearer"],
      `${path}.authentication`,
    );
    const username = validateHttpProxyUsername(
      authentication,
      inputOptionalString(record, "username", path),
      `${path}.username`,
    );
    const tlsCertificatePolicy = parseTlsPolicy(
      record.tlsCertificatePolicy,
      `${path}.tlsCertificatePolicy`,
    );
    const configuration: HttpConnectProxyConfigurationInput = {
      type,
      url: validateHttpProxyUrl(
        expectString(record.url, `${path}.url`),
        tlsCertificatePolicy,
        `${path}.url`,
      ),
      authentication,
      ...(username === undefined ? {} : { username }),
      nonSensitiveHeaders: validateHeaders(
        inputStringMap(record, "nonSensitiveHeaders", path),
        `${path}.nonSensitiveHeaders`,
        "httpConnect",
      ),
      connectTimeoutMs: validateConnectTimeout(
        expectSafeInteger(record.connectTimeoutMs, `${path}.connectTimeoutMs`),
        `${path}.connectTimeoutMs`,
      ),
      tlsCertificatePolicy,
    };
    return configuration;
  }

  if (type === "socks5") {
    const authentication = expectEnum(
      record.authentication,
      ["none", "usernamePassword"],
      `${path}.authentication`,
    );
    const username = validateOptionalUsername(
      authentication === "usernamePassword",
      inputOptionalString(record, "username", path),
      `${path}.username`,
    );
    const configuration: Socks5ProxyConfigurationInput = {
      type,
      host: validateHost(
        expectString(record.host, `${path}.host`),
        `${path}.host`,
      ),
      port: expectPort(record.port, `${path}.port`),
      authentication,
      ...(username === undefined ? {} : { username }),
      dnsResolution: expectEnum(
        record.dnsResolution,
        ["proxy", "local"],
        `${path}.dnsResolution`,
      ),
      connectTimeoutMs: validateConnectTimeout(
        expectSafeInteger(record.connectTimeoutMs, `${path}.connectTimeoutMs`),
        `${path}.connectTimeoutMs`,
      ),
    };
    return configuration;
  }

  const keepAliveIntervalMs = expectSafeInteger(
    record.keepAliveIntervalMs,
    `${path}.keepAliveIntervalMs`,
  );
  if (
    keepAliveIntervalMs < MIN_KEEP_ALIVE_INTERVAL_MS ||
    keepAliveIntervalMs > MAX_KEEP_ALIVE_INTERVAL_MS
  ) {
    invalid(`${path}.keepAliveIntervalMs`, "contains an invalid keep-alive interval");
  }
  const keepAliveMaxFailures = expectSafeInteger(
    record.keepAliveMaxFailures,
    `${path}.keepAliveMaxFailures`,
  );
  if (
    keepAliveMaxFailures < 1 ||
    keepAliveMaxFailures > MAX_KEEP_ALIVE_FAILURES
  ) {
    invalid(`${path}.keepAliveMaxFailures`, "contains an invalid keep-alive failure count");
  }
  const portValue = record.port;
  const configuration: SshProxyConfigurationInput = {
    type,
    host: validateHost(
      expectString(record.host, `${path}.host`),
      `${path}.host`,
    ),
    port:
      portValue === undefined
        ? DEFAULT_SSH_PORT
        : expectPort(portValue, `${path}.port`),
    username: validateUsername(
      expectString(record.username, `${path}.username`),
      `${path}.username`,
    ),
    authentication: normalizeSshAuthenticationInput(
      record.authentication,
      `${path}.authentication`,
    ),
    connectTimeoutMs: validateConnectTimeout(
      expectSafeInteger(record.connectTimeoutMs, `${path}.connectTimeoutMs`),
      `${path}.connectTimeoutMs`,
    ),
    keepAliveIntervalMs,
    keepAliveMaxFailures,
  };
  return configuration;
}

export function normalizeCreateServerProfileRequest(
  value: CreateServerProfileRequest,
): CreateServerProfileRequest {
  const record = expectRecord(value, "request");
  return {
    name: validateName(
      expectString(record.name, "request.name"),
      "request.name",
      false,
    ),
    configuration: normalizeServerConfigurationInput(
      record.configuration as ServerConfigurationInput,
    ),
  };
}

export function normalizeUpdateServerProfileRequest(
  value: UpdateServerProfileRequest,
): UpdateServerProfileRequest {
  const record = expectRecord(value, "request");
  return {
    serverId: expectServerId(record.serverId, "request.serverId"),
    expectedVersion: expectVersion(
      record.expectedVersion,
      "request.expectedVersion",
    ),
    name: validateName(
      expectString(record.name, "request.name"),
      "request.name",
      false,
    ),
    configuration: normalizeServerConfigurationInput(
      record.configuration as ServerConfigurationInput,
    ),
  };
}

export function normalizeDeleteServerProfileRequest(
  value: DeleteServerProfileRequest,
): DeleteServerProfileRequest {
  const record = expectRecord(value, "request");
  return {
    serverId: expectServerId(record.serverId, "request.serverId"),
    expectedVersion: expectVersion(
      record.expectedVersion,
      "request.expectedVersion",
    ),
  };
}

export function normalizeCreateProxyProfileRequest(
  value: CreateProxyProfileRequest,
): CreateProxyProfileRequest {
  const record = expectRecord(value, "request");
  return {
    name: validateName(
      expectString(record.name, "request.name"),
      "request.name",
      false,
    ),
    configuration: normalizeProxyConfigurationInput(
      record.configuration as ProxyConfigurationInput,
    ),
  };
}

export function normalizeUpdateProxyProfileRequest(
  value: UpdateProxyProfileRequest,
): UpdateProxyProfileRequest {
  const record = expectRecord(value, "request");
  return {
    proxyId: expectProxyId(record.proxyId, "request.proxyId"),
    expectedVersion: expectVersion(
      record.expectedVersion,
      "request.expectedVersion",
    ),
    name: validateName(
      expectString(record.name, "request.name"),
      "request.name",
      false,
    ),
    configuration: normalizeProxyConfigurationInput(
      record.configuration as ProxyConfigurationInput,
    ),
  };
}

export function normalizeDeleteProxyProfileRequest(
  value: DeleteProxyProfileRequest,
): DeleteProxyProfileRequest {
  const record = expectRecord(value, "request");
  return {
    proxyId: expectProxyId(record.proxyId, "request.proxyId"),
    expectedVersion: expectVersion(
      record.expectedVersion,
      "request.expectedVersion",
    ),
  };
}

export function normalizeRemoveProxySshHostKeyRequest(
  value: RemoveProxySshHostKeyRequest,
): RemoveProxySshHostKeyRequest {
  const record = expectRecord(value, "request");
  return {
    proxyId: expectProxyId(record.proxyId, "request.proxyId"),
    expectedVersion: expectVersion(
      record.expectedVersion,
      "request.expectedVersion",
    ),
  };
}

export function normalizeConfirmProxySshHostKeyRequest(
  value: ConfirmProxySshHostKeyRequest,
): ConfirmProxySshHostKeyRequest {
  const record = expectRecord(value, "request");
  const algorithm = expectString(record.algorithm, "request.algorithm");
  if (
    algorithm.trim().length === 0 ||
    byteLength(algorithm) > MAX_ALGORITHM_BYTES ||
    CONTROL_CHARACTER_PATTERN.test(algorithm)
  ) {
    invalid("request.algorithm", "contains an invalid SSH host-key algorithm");
  }
  const sha256Fingerprint = expectString(
    record.sha256Fingerprint,
    "request.sha256Fingerprint",
  );
  if (!SSH_SHA256_FINGERPRINT_PATTERN.test(sha256Fingerprint)) {
    invalid("request.sha256Fingerprint", "contains an invalid SHA256 fingerprint");
  }
  return {
    proxyId: expectProxyId(record.proxyId, "request.proxyId"),
    expectedVersion: expectVersion(record.expectedVersion, "request.expectedVersion"),
    host: validateHost(expectString(record.host, "request.host"), "request.host"),
    port: expectPort(record.port, "request.port"),
    algorithm,
    sha256Fingerprint,
  };
}

export function normalizeRecordProxyTestRequest(
  value: RecordProxyTestRequest,
): RecordProxyTestRequest {
  const record = expectRecord(value, "request");
  return {
    proxyId: expectProxyId(record.proxyId, "request.proxyId"),
    expectedVersion: expectVersion(record.expectedVersion, "request.expectedVersion"),
    status: expectEnum(record.status, ["succeeded", "failed"], "request.status"),
  };
}

export function normalizeSetServerCredentialRequest(
  value: SetServerCredentialRequest,
): SetServerCredentialRequest {
  const record = expectRecord(value, "request");
  return {
    serverId: expectServerId(record.serverId, "request.serverId"),
    expectedVersion: expectVersion(
      record.expectedVersion,
      "request.expectedVersion",
    ),
    credential: normalizeServerCredential(
      record.credential,
      "request.credential",
    ),
  };
}

export function normalizeClearServerCredentialRequest(
  value: ClearServerCredentialRequest,
): ClearServerCredentialRequest {
  const record = expectRecord(value, "request");
  return {
    serverId: expectServerId(record.serverId, "request.serverId"),
    expectedVersion: expectVersion(
      record.expectedVersion,
      "request.expectedVersion",
    ),
    credentialType: expectEnum(
      record.credentialType,
      SERVER_CREDENTIAL_TYPES,
      "request.credentialType",
    ),
  };
}

export function normalizeSetProxyCredentialRequest(
  value: SetProxyCredentialRequest,
): SetProxyCredentialRequest {
  const record = expectRecord(value, "request");
  return {
    proxyId: expectProxyId(record.proxyId, "request.proxyId"),
    expectedVersion: expectVersion(
      record.expectedVersion,
      "request.expectedVersion",
    ),
    credential: normalizeProxyCredential(record.credential, "request.credential"),
  };
}

export function normalizeClearProxyCredentialRequest(
  value: ClearProxyCredentialRequest,
): ClearProxyCredentialRequest {
  const record = expectRecord(value, "request");
  return {
    proxyId: expectProxyId(record.proxyId, "request.proxyId"),
    expectedVersion: expectVersion(
      record.expectedVersion,
      "request.expectedVersion",
    ),
    credentialType: expectEnum(
      record.credentialType,
      PROXY_CREDENTIAL_TYPES,
      "request.credentialType",
    ),
  };
}
