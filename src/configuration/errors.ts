const CONFIGURATION_COMMAND_ERROR_MESSAGES = {
  invalidServerName: "The server name is invalid",
  invalidProxyName: "The proxy name is invalid",
  invalidConfigurationVersion: "The configuration version is invalid",
  invalidExecutablePath: "The executable path must be absolute",
  invalidWorkingDirectory: "The working directory must be absolute",
  invalidSshPrivateKeyPath:
    "The SSH private key must be an absolute, readable regular file",
  invalidServerArguments: "The server arguments are invalid",
  invalidNonSensitiveEnvironment: "The non-sensitive environment is invalid",
  invalidNonSensitiveHeaders: "The non-sensitive headers are invalid",
  invalidWebSocketUrl: "The WebSocket URL is invalid",
  invalidProxyUrl: "The proxy URL is invalid",
  invalidPlaintextConfirmation:
    "Plaintext WebSocket transport must be confirmed explicitly",
  invalidTlsCertificatePolicy: "The TLS certificate policy is invalid",
  invalidConnectTimeout: "The connection timeout is invalid",
  invalidProxyHost: "The proxy host is invalid",
  invalidProxyPort: "The proxy port is invalid",
  invalidProxyUsername: "The proxy username is invalid",
  invalidSshKeepAliveInterval: "The SSH keep-alive interval is invalid",
  invalidSshKeepAliveFailures: "The SSH keep-alive failure count is invalid",
  invalidSshHostKeyRecord: "The SSH host key record is invalid",
  serverNameConflict: "The server name is already in use",
  proxyNameConflict: "The proxy name is already in use",
  serverNotFound: "The server does not exist",
  proxyNotFound: "The proxy does not exist",
  serverVersionConflict: "The server configuration was modified concurrently",
  proxyVersionConflict: "The proxy configuration was modified concurrently",
  proxyReferenced: "The proxy is referenced by one or more servers",
  serverInUse: "The server is currently used by one or more windows",
  credentialChangeRequired: "The stored credential must be changed explicitly",
  credentialConfigurationMismatch:
    "The credential does not match the current configuration",
  credentialNotConfigured: "The required credential is not configured",
  invalidCredentialValue: "The credential value is invalid",
  invalidSensitiveEnvironment: "The sensitive environment is invalid",
  credentialServiceUnavailable: "The system credential service is unavailable",
  credentialServiceLocked: "The system credential service is locked",
  credentialServiceTimedOut:
    "The system credential service did not respond in time",
  credentialPromptDismissed: "The credential access prompt was dismissed",
  credentialAccessDenied: "Access to the system credential service was denied",
  credentialNotFound: "The saved credential does not exist",
  credentialRecordInvalid: "The saved credential record is invalid",
  plaintextCredentialConfirmationRequired:
    "Plaintext credential storage requires explicit confirmation",
  credentialStorageFailed: "The system credential operation failed",
  sshHostKeyRemovalRequired:
    "The saved SSH host key must be removed before changing the endpoint",
  sshHostKeyNotFound: "The saved SSH host key does not exist",
  configurationCorrupt: "The persisted configuration is corrupt",
  configurationDatabaseFailed: "The configuration database operation failed",
  configurationCommandFailed: "The configuration operation failed",
} as const;

export type ConfigurationCommandErrorCode =
  keyof typeof CONFIGURATION_COMMAND_ERROR_MESSAGES;

export class ConfigurationCommandError extends Error {
  readonly code: ConfigurationCommandErrorCode;

  constructor(code: ConfigurationCommandErrorCode) {
    super(CONFIGURATION_COMMAND_ERROR_MESSAGES[code]);
    this.name = "ConfigurationCommandError";
    this.code = code;
  }
}

function hasOwn(record: object, key: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

export function parseConfigurationCommandError(
  value: unknown,
): ConfigurationCommandError {
  try {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return new ConfigurationCommandError("configurationCommandFailed");
    }

    const keys = Reflect.ownKeys(value);
    if (
      keys.length !== 2 ||
      !hasOwn(value, "code") ||
      !hasOwn(value, "message")
    ) {
      return new ConfigurationCommandError("configurationCommandFailed");
    }

    const record = value as Record<PropertyKey, unknown>;
    const code = record.code;
    const message = record.message;
    if (
      typeof code !== "string" ||
      typeof message !== "string" ||
      !hasOwn(CONFIGURATION_COMMAND_ERROR_MESSAGES, code)
    ) {
      return new ConfigurationCommandError("configurationCommandFailed");
    }

    const knownCode = code as ConfigurationCommandErrorCode;
    if (message !== CONFIGURATION_COMMAND_ERROR_MESSAGES[knownCode]) {
      return new ConfigurationCommandError("configurationCommandFailed");
    }

    return new ConfigurationCommandError(knownCode);
  } catch {
    return new ConfigurationCommandError("configurationCommandFailed");
  }
}
