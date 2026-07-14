import {
  ConfigurationContractError,
  normalizeClearProxyCredentialRequest,
  normalizeConfirmProxySshHostKeyRequest,
  normalizeClearServerCredentialRequest,
  normalizeCreateProxyProfileRequest,
  normalizeCreateServerProfileRequest,
  normalizeDeleteProxyProfileRequest,
  normalizeDeleteServerProfileRequest,
  normalizeRemoveProxySshHostKeyRequest,
  normalizeRecordProxyTestRequest,
  normalizeSetProxyCredentialRequest,
  normalizeSetServerCredentialRequest,
  normalizeUpdateProxyProfileRequest,
  normalizeUpdateServerProfileRequest,
  parseConfigurationCommandError,
  parseConfigurationSnapshot,
  parseEmptyConfigurationResponse,
  parseProxyProfile,
  parseServerProfile,
} from "../configuration";
import type {
  ClearProxyCredentialRequest,
  ConfirmProxySshHostKeyRequest,
  ClearServerCredentialRequest,
  ConfigurationSnapshot,
  CreateProxyProfileRequest,
  CreateServerProfileRequest,
  DeleteProxyProfileRequest,
  DeleteServerProfileRequest,
  ProxyProfile,
  RecordProxyTestRequest,
  RemoveProxySshHostKeyRequest,
  ServerProfile,
  ServerCredentialType,
  SetProxyCredentialRequest,
  SetServerCredentialRequest,
  ProxyCredentialType,
  UpdateProxyProfileRequest,
  UpdateServerProfileRequest,
} from "../configuration";
import { tauriIpc } from "./tauriIpc";
import type { TauriIpc } from "./tauriIpc";
import { listen } from "@tauri-apps/api/event";

const LIST_CONFIGURATION_PROFILES_COMMAND = "list_configuration_profiles";
const CREATE_SERVER_PROFILE_COMMAND = "create_server_profile";
const UPDATE_SERVER_PROFILE_COMMAND = "update_server_profile";
const DELETE_SERVER_PROFILE_COMMAND = "delete_server_profile";
const CREATE_PROXY_PROFILE_COMMAND = "create_proxy_profile";
const UPDATE_PROXY_PROFILE_COMMAND = "update_proxy_profile";
const DELETE_PROXY_PROFILE_COMMAND = "delete_proxy_profile";
const REMOVE_PROXY_SSH_HOST_KEY_COMMAND = "remove_proxy_ssh_host_key";
const CONFIRM_PROXY_SSH_HOST_KEY_COMMAND = "confirm_proxy_ssh_host_key";
const RECORD_PROXY_TEST_COMMAND = "record_proxy_test";
const SET_SERVER_CREDENTIAL_COMMAND = "set_server_credential";
const CLEAR_SERVER_CREDENTIAL_COMMAND = "clear_server_credential";
const SET_PROXY_CREDENTIAL_COMMAND = "set_proxy_credential";
const CLEAR_PROXY_CREDENTIAL_COMMAND = "clear_proxy_credential";

export type ConfigurationIpc = Pick<TauriIpc, "invoke">;
export type ConfigurationProfilesChangeSubscriber = (
  onChange: () => void,
) => Promise<() => void>;

export async function subscribeConfigurationProfileChanges(
  onChange: () => void,
): Promise<() => void> {
  return listen<null>("configuration-profiles-changed", (event) => {
    if (event.payload === null) onChange();
  });
}

async function invokeConfiguration(
  ipc: ConfigurationIpc,
  command: string,
  arguments_: Record<string, unknown>,
): Promise<unknown> {
  try {
    return await ipc.invoke<unknown>(command, arguments_);
  } catch (error) {
    throw parseConfigurationCommandError(error);
  }
}

function assertCredentialVersion(
  actualVersion: number,
  expectedVersion: number,
  operation: "set" | "clear",
  path: string,
): void {
  const changedVersion = expectedVersion + 1;
  const valid =
    operation === "set"
      ? actualVersion === changedVersion
      : actualVersion === expectedVersion || actualVersion === changedVersion;
  if (!valid) {
    throw new ConfigurationContractError(
      `${path}.version`,
      `does not satisfy the ${operation} credential version contract`,
    );
  }
}

function assertUpdatedServerResponse(
  profile: ServerProfile,
  request: UpdateServerProfileRequest,
): void {
  if (profile.serverId !== request.serverId) {
    throw new ConfigurationContractError(
      "server.serverId",
      "does not match the update request",
    );
  }
  if (profile.version !== request.expectedVersion + 1) {
    throw new ConfigurationContractError(
      "server.version",
      "does not follow the update request version",
    );
  }
}

function assertUpdatedProxyResponse(
  profile: ProxyProfile,
  request:
    | UpdateProxyProfileRequest
    | RemoveProxySshHostKeyRequest
    | ConfirmProxySshHostKeyRequest,
): void {
  if (profile.proxyId !== request.proxyId) {
    throw new ConfigurationContractError(
      "proxy.proxyId",
      "does not match the update request",
    );
  }
  if (profile.version !== request.expectedVersion + 1) {
    throw new ConfigurationContractError(
      "proxy.version",
      "does not follow the update request version",
    );
  }
}

function assertServerCredentialResponse(
  profile: ServerProfile,
  serverId: SetServerCredentialRequest["serverId"],
  expectedVersion: number,
  credentialType: ServerCredentialType,
  operation: "set" | "clear",
): void {
  if (profile.serverId !== serverId) {
    throw new ConfigurationContractError(
      "server.serverId",
      "does not match the credential request",
    );
  }
  const typeMatches =
    (credentialType === "sensitiveEnvironment" &&
      profile.configuration.type === "localStdio") ||
    (credentialType === "bearerToken" &&
      profile.configuration.type === "remoteWebSocket" &&
      profile.configuration.authentication === "bearer");
  if (!typeMatches) {
    throw new ConfigurationContractError(
      "server.configuration",
      "does not match the requested credential type",
    );
  }
  assertCredentialVersion(
    profile.version,
    expectedVersion,
    operation,
    "server",
  );
}

function assertProxyCredentialResponse(
  profile: ProxyProfile,
  proxyId: SetProxyCredentialRequest["proxyId"],
  expectedVersion: number,
  credentialType: ProxyCredentialType,
  operation: "set" | "clear",
): void {
  if (profile.proxyId !== proxyId) {
    throw new ConfigurationContractError(
      "proxy.proxyId",
      "does not match the credential request",
    );
  }
  const configuration = profile.configuration;
  const typeMatches =
    (credentialType === "httpBasicPassword" &&
      configuration.type === "httpConnect" &&
      configuration.authentication === "basic") ||
    (credentialType === "httpBearerToken" &&
      configuration.type === "httpConnect" &&
      configuration.authentication === "bearer") ||
    (credentialType === "socks5Password" &&
      configuration.type === "socks5" &&
      configuration.authentication === "usernamePassword") ||
    (credentialType === "sshPrivateKeyPassphrase" &&
      configuration.type === "ssh" &&
      configuration.authentication.type === "privateKey") ||
    (credentialType === "sshPassword" &&
      configuration.type === "ssh" &&
      configuration.authentication.type === "password");
  if (!typeMatches) {
    throw new ConfigurationContractError(
      "proxy.configuration",
      "does not match the requested credential type",
    );
  }
  assertCredentialVersion(profile.version, expectedVersion, operation, "proxy");
}

export async function listConfigurationProfiles(
  ipc: ConfigurationIpc = tauriIpc,
): Promise<ConfigurationSnapshot> {
  const response = await invokeConfiguration(
    ipc,
    LIST_CONFIGURATION_PROFILES_COMMAND,
    {},
  );
  return parseConfigurationSnapshot(response);
}

export async function createServerProfile(
  request: CreateServerProfileRequest,
  ipc: ConfigurationIpc = tauriIpc,
): Promise<ServerProfile> {
  const response = await invokeConfiguration(
    ipc,
    CREATE_SERVER_PROFILE_COMMAND,
    {
      request: normalizeCreateServerProfileRequest(request),
    },
  );
  return parseServerProfile(response);
}

export async function updateServerProfile(
  request: UpdateServerProfileRequest,
  ipc: ConfigurationIpc = tauriIpc,
): Promise<ServerProfile> {
  const normalizedRequest = normalizeUpdateServerProfileRequest(request);
  const response = await invokeConfiguration(
    ipc,
    UPDATE_SERVER_PROFILE_COMMAND,
    {
      request: normalizedRequest,
    },
  );
  const profile = parseServerProfile(response);
  assertUpdatedServerResponse(profile, normalizedRequest);
  return profile;
}

export async function deleteServerProfile(
  request: DeleteServerProfileRequest,
  ipc: ConfigurationIpc = tauriIpc,
): Promise<void> {
  const response = await invokeConfiguration(
    ipc,
    DELETE_SERVER_PROFILE_COMMAND,
    {
      request: normalizeDeleteServerProfileRequest(request),
    },
  );
  parseEmptyConfigurationResponse(response);
}

export async function createProxyProfile(
  request: CreateProxyProfileRequest,
  ipc: ConfigurationIpc = tauriIpc,
): Promise<ProxyProfile> {
  const response = await invokeConfiguration(
    ipc,
    CREATE_PROXY_PROFILE_COMMAND,
    {
      request: normalizeCreateProxyProfileRequest(request),
    },
  );
  return parseProxyProfile(response);
}

export async function updateProxyProfile(
  request: UpdateProxyProfileRequest,
  ipc: ConfigurationIpc = tauriIpc,
): Promise<ProxyProfile> {
  const normalizedRequest = normalizeUpdateProxyProfileRequest(request);
  const response = await invokeConfiguration(
    ipc,
    UPDATE_PROXY_PROFILE_COMMAND,
    {
      request: normalizedRequest,
    },
  );
  const profile = parseProxyProfile(response);
  assertUpdatedProxyResponse(profile, normalizedRequest);
  return profile;
}

export async function deleteProxyProfile(
  request: DeleteProxyProfileRequest,
  ipc: ConfigurationIpc = tauriIpc,
): Promise<void> {
  const response = await invokeConfiguration(
    ipc,
    DELETE_PROXY_PROFILE_COMMAND,
    {
      request: normalizeDeleteProxyProfileRequest(request),
    },
  );
  parseEmptyConfigurationResponse(response);
}

export async function removeProxySshHostKey(
  request: RemoveProxySshHostKeyRequest,
  ipc: ConfigurationIpc = tauriIpc,
): Promise<ProxyProfile> {
  const normalizedRequest = normalizeRemoveProxySshHostKeyRequest(request);
  const response = await invokeConfiguration(
    ipc,
    REMOVE_PROXY_SSH_HOST_KEY_COMMAND,
    {
      request: normalizedRequest,
    },
  );
  const profile = parseProxyProfile(response);
  assertUpdatedProxyResponse(profile, normalizedRequest);
  return profile;
}

export async function confirmProxySshHostKey(
  request: ConfirmProxySshHostKeyRequest,
  ipc: ConfigurationIpc = tauriIpc,
): Promise<ProxyProfile> {
  const normalizedRequest = normalizeConfirmProxySshHostKeyRequest(request);
  const response = await invokeConfiguration(
    ipc,
    CONFIRM_PROXY_SSH_HOST_KEY_COMMAND,
    { request: normalizedRequest },
  );
  const profile = parseProxyProfile(response);
  assertUpdatedProxyResponse(profile, normalizedRequest);
  if (
    profile.sshHostKey?.host !== normalizedRequest.host ||
    profile.sshHostKey.port !== normalizedRequest.port ||
    profile.sshHostKey.algorithm !== normalizedRequest.algorithm ||
    profile.sshHostKey.sha256Fingerprint !== normalizedRequest.sha256Fingerprint
  ) {
    throw new ConfigurationContractError(
      "proxy.sshHostKey",
      "does not match the confirmed host key",
    );
  }
  return profile;
}

export async function recordProxyTest(
  request: RecordProxyTestRequest,
  ipc: ConfigurationIpc = tauriIpc,
): Promise<ProxyProfile> {
  const normalizedRequest = normalizeRecordProxyTestRequest(request);
  const response = await invokeConfiguration(ipc, RECORD_PROXY_TEST_COMMAND, {
    request: normalizedRequest,
  });
  const profile = parseProxyProfile(response);
  if (
    profile.proxyId !== normalizedRequest.proxyId ||
    profile.version !== normalizedRequest.expectedVersion ||
    profile.lastTest?.status !== normalizedRequest.status
  ) {
    throw new ConfigurationContractError(
      "proxy.lastTest",
      "does not match the recorded proxy test",
    );
  }
  return profile;
}

export async function setServerCredential(
  request: SetServerCredentialRequest,
  ipc: ConfigurationIpc = tauriIpc,
): Promise<ServerProfile> {
  const normalizedRequest = normalizeSetServerCredentialRequest(request);
  const response = await invokeConfiguration(
    ipc,
    SET_SERVER_CREDENTIAL_COMMAND,
    {
      request: normalizedRequest,
    },
  );
  const profile = parseServerProfile(response);
  if (!profile.credentialConfigured) {
    throw new ConfigurationContractError(
      "server.credentialConfigured",
      "must be true after setting a credential",
    );
  }
  assertServerCredentialResponse(
    profile,
    normalizedRequest.serverId,
    normalizedRequest.expectedVersion,
    normalizedRequest.credential.type,
    "set",
  );
  return profile;
}

export async function clearServerCredential(
  request: ClearServerCredentialRequest,
  ipc: ConfigurationIpc = tauriIpc,
): Promise<ServerProfile> {
  const normalizedRequest = normalizeClearServerCredentialRequest(request);
  const response = await invokeConfiguration(
    ipc,
    CLEAR_SERVER_CREDENTIAL_COMMAND,
    {
      request: normalizedRequest,
    },
  );
  const profile = parseServerProfile(response);
  if (profile.credentialConfigured) {
    throw new ConfigurationContractError(
      "server.credentialConfigured",
      "must be false after clearing a credential",
    );
  }
  assertServerCredentialResponse(
    profile,
    normalizedRequest.serverId,
    normalizedRequest.expectedVersion,
    normalizedRequest.credentialType,
    "clear",
  );
  return profile;
}

export async function setProxyCredential(
  request: SetProxyCredentialRequest,
  ipc: ConfigurationIpc = tauriIpc,
): Promise<ProxyProfile> {
  const normalizedRequest = normalizeSetProxyCredentialRequest(request);
  const response = await invokeConfiguration(
    ipc,
    SET_PROXY_CREDENTIAL_COMMAND,
    {
      request: normalizedRequest,
    },
  );
  const profile = parseProxyProfile(response);
  if (!profile.credentialConfigured) {
    throw new ConfigurationContractError(
      "proxy.credentialConfigured",
      "must be true after setting a credential",
    );
  }
  assertProxyCredentialResponse(
    profile,
    normalizedRequest.proxyId,
    normalizedRequest.expectedVersion,
    normalizedRequest.credential.type,
    "set",
  );
  return profile;
}

export async function clearProxyCredential(
  request: ClearProxyCredentialRequest,
  ipc: ConfigurationIpc = tauriIpc,
): Promise<ProxyProfile> {
  const normalizedRequest = normalizeClearProxyCredentialRequest(request);
  const response = await invokeConfiguration(
    ipc,
    CLEAR_PROXY_CREDENTIAL_COMMAND,
    {
      request: normalizedRequest,
    },
  );
  const profile = parseProxyProfile(response);
  if (profile.credentialConfigured) {
    throw new ConfigurationContractError(
      "proxy.credentialConfigured",
      "must be false after clearing a credential",
    );
  }
  assertProxyCredentialResponse(
    profile,
    normalizedRequest.proxyId,
    normalizedRequest.expectedVersion,
    normalizedRequest.credentialType,
    "clear",
  );
  return profile;
}
