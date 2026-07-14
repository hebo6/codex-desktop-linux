import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { ProxyEditorMode, ProxyEditorSubmission } from "../components/proxyEditorModel";
import type { SshHostKeyPrompt } from "../components/serverEditorModel";
import { existingProxyCredentialType } from "../components/proxyEditorModel";
import {
  ConfigurationCommandError,
  type ConfigurationCommandErrorCode,
  type ProxyId,
  type ProxyProfile,
} from "../configuration";
import { useAppDispatch } from "../store/hooks";
import { proxyProfileRemoved, proxyProfileUpserted } from "../store/configurationSlice";
import {
  clearProxyCredential,
  confirmProxySshHostKey,
  createProxyProfile,
  deleteProxyProfile,
  removeProxySshHostKey,
  recordProxyTest,
  setProxyCredential,
  updateProxyProfile,
} from "../transport/configuration";
import type { ConfigurationMutationRunner, ServerProfileMutationState } from "./useServerProfileMutations";

export interface ProxyProfileMutationCommands {
  readonly createProxyProfile: typeof createProxyProfile;
  readonly updateProxyProfile: typeof updateProxyProfile;
  readonly deleteProxyProfile: typeof deleteProxyProfile;
  readonly setProxyCredential: typeof setProxyCredential;
  readonly clearProxyCredential: typeof clearProxyCredential;
  readonly removeProxySshHostKey: typeof removeProxySshHostKey;
  readonly confirmProxySshHostKey: typeof confirmProxySshHostKey;
  readonly recordProxyTest: typeof recordProxyTest;
}

type DataEffect =
  | "configurationSavedCredentialNotSaved"
  | "credentialClearedConfigurationNotSaved"
  | "configurationSavedHostKeyNotSaved";

export type ProxyProfileSaveOutcome =
  | { readonly status: "saved"; readonly profile: ProxyProfile }
  | { readonly status: "partiallySaved"; readonly profile: ProxyProfile; readonly dataEffect: DataEffect; readonly error: string; readonly errorCode: ConfigurationCommandErrorCode | null }
  | { readonly status: "failed"; readonly error: string; readonly errorCode: ConfigurationCommandErrorCode | null };

export type ProxyProfileDeleteOutcome =
  | { readonly status: "deleted"; readonly proxyId: ProxyId }
  | { readonly status: "failed"; readonly error: string; readonly errorCode: ConfigurationCommandErrorCode | null };

export interface ProxyProfileMutationControls {
  readonly saveProfile: (mode: ProxyEditorMode, submission: ProxyEditorSubmission) => Promise<ProxyProfileSaveOutcome>;
  readonly deleteProfile: (proxyId: ProxyId, version: number) => Promise<ProxyProfileDeleteOutcome>;
  readonly removeHostKey: (profile: ProxyProfile) => Promise<ProxyProfileSaveOutcome>;
  readonly confirmHostKey: (
    profile: ProxyProfile,
    prompt: Extract<SshHostKeyPrompt, { readonly kind: "unknown" }>,
  ) => Promise<ProxyProfileSaveOutcome>;
  readonly recordTest: (
    profile: ProxyProfile,
    status: "succeeded" | "failed",
  ) => Promise<ProxyProfile | null>;
  readonly saveState: ServerProfileMutationState<ProxyProfileSaveOutcome>;
  readonly deleteState: ServerProfileMutationState<ProxyProfileDeleteOutcome>;
  readonly resetSave: () => void;
  readonly resetDelete: () => void;
}

const DEFAULT_COMMANDS: ProxyProfileMutationCommands = {
  createProxyProfile,
  updateProxyProfile,
  deleteProxyProfile,
  setProxyCredential,
  clearProxyCredential,
  removeProxySshHostKey,
  confirmProxySshHostKey,
  recordProxyTest,
};
const NO_COMMAND_OVERRIDES: Partial<ProxyProfileMutationCommands> = Object.freeze({});

const ERROR_SUMMARIES: Partial<Record<ConfigurationCommandErrorCode, string>> = {
  invalidProxyName: "代理名称无效，请检查后重试",
  invalidProxyUrl: "代理 URL 无效",
  invalidProxyHost: "代理主机无效",
  invalidProxyPort: "代理端口无效",
  invalidProxyUsername: "代理用户名无效",
  invalidSshPrivateKeyPath: "SSH 私钥路径不可读取",
  invalidNonSensitiveHeaders: "代理普通请求头无效",
  invalidConnectTimeout: "连接超时时间无效",
  invalidSshKeepAliveInterval: "SSH 保活间隔无效",
  invalidSshKeepAliveFailures: "SSH 保活失败次数无效",
  proxyNameConflict: "已存在同名代理，请更换名称",
  proxyNotFound: "代理配置已不存在，请重新加载",
  proxyVersionConflict: "代理配置已被其他操作修改，请重新加载",
  proxyReferenced: "代理仍被服务器引用，无法删除",
  credentialChangeRequired: "认证方式已变化，请明确更新或清除凭据",
  credentialConfigurationMismatch: "代理凭据与认证方式不匹配",
  invalidCredentialValue: "代理凭据格式或长度无效",
  credentialServiceUnavailable: "系统凭据服务不可用，请检查系统密钥环",
  credentialServiceLocked: "系统凭据服务已锁定，请解锁后重试",
  credentialServiceTimedOut: "系统凭据服务响应超时，请重试",
  credentialPromptDismissed: "凭据访问确认已取消",
  credentialAccessDenied: "系统拒绝访问凭据服务",
  credentialNotFound: "已保存的代理凭据不存在，请重新填写",
  credentialRecordInvalid: "已保存的代理凭据记录无效，请重新填写",
  credentialStorageFailed: "系统未能完成代理凭据操作，请重试",
  sshHostKeyRemovalRequired: "更改 SSH 端点前必须先移除已保存的主机密钥",
  sshHostKeyNotFound: "已保存的 SSH 主机密钥不存在",
  configurationCorrupt: "本地代理配置已损坏",
  configurationDatabaseFailed: "本地配置数据库操作失败，请重试",
  configurationCommandFailed: "代理配置操作失败，请重试",
};

const UNKNOWN_ERROR = "代理配置操作失败，请重试";
const BUSY_ERROR = "正在处理另一项代理配置操作，请稍候";

function issue(error: unknown): { readonly error: string; readonly errorCode: ConfigurationCommandErrorCode | null } {
  if (error instanceof ConfigurationCommandError) {
    return { error: ERROR_SUMMARIES[error.code] ?? UNKNOWN_ERROR, errorCode: error.code };
  }
  return { error: UNKNOWN_ERROR, errorCode: null };
}

function failed(error: unknown): Extract<ProxyProfileSaveOutcome, { status: "failed" }> {
  return { status: "failed", ...issue(error) };
}

function partial(profile: ProxyProfile, dataEffect: DataEffect, error: unknown): Extract<ProxyProfileSaveOutcome, { status: "partiallySaved" }> {
  const prefix = dataEffect === "configurationSavedCredentialNotSaved"
    ? "代理配置已保存，但新凭据未保存"
    : dataEffect === "credentialClearedConfigurationNotSaved"
      ? "代理凭据已清除，但配置修改未保存"
      : "代理配置已保存，但草稿主机密钥未保存";
  const details = issue(error);
  return { status: "partiallySaved", profile, dataEffect, ...details, error: `${prefix}。${details.error}` };
}

export async function executeProxyProfileSave(
  mode: ProxyEditorMode,
  submission: ProxyEditorSubmission,
  commands: ProxyProfileMutationCommands,
  confirm: (profile: ProxyProfile) => ProxyProfile,
): Promise<ProxyProfileSaveOutcome> {
  const finalize = async (profile: ProxyProfile): Promise<ProxyProfileSaveOutcome> => {
    const hostKey = submission.sshHostKey;
    if (
      hostKey === undefined ||
      (profile.sshHostKey?.host === hostKey.host &&
        profile.sshHostKey.port === hostKey.port &&
        profile.sshHostKey.algorithm === hostKey.algorithm &&
        profile.sshHostKey.sha256Fingerprint === hostKey.sha256Fingerprint)
    ) {
      return { status: "saved", profile };
    }
    try {
      return {
        status: "saved",
        profile: confirm(await commands.confirmProxySshHostKey({
          proxyId: profile.proxyId,
          expectedVersion: profile.version,
          host: hostKey.host,
          port: hostKey.port,
          algorithm: hostKey.algorithm,
          sha256Fingerprint: hostKey.sha256Fingerprint,
        })),
      };
    } catch (error) {
      return partial(profile, "configurationSavedHostKeyNotSaved", error);
    }
  };
  if (mode.type === "create") {
    let created: ProxyProfile;
    try {
      created = confirm(await commands.createProxyProfile({ name: submission.name, configuration: submission.configuration }));
    } catch (error) {
      return failed(error);
    }
    if (submission.credentialIntent.type === "keep") return finalize(created);
    if (submission.credentialIntent.type === "clear") return failed(new TypeError("new proxy cannot clear credential"));
    try {
      const updated = confirm(await commands.setProxyCredential({
        proxyId: created.proxyId,
        expectedVersion: created.version,
        credential: submission.credentialIntent.credential,
      }));
      return finalize(updated);
    } catch (error) {
      return partial(created, "configurationSavedCredentialNotSaved", error);
    }
  }

  const original = mode.profile;
  let expectedVersion = original.version;
  let latest = original;
  const update = async () => {
    latest = confirm(await commands.updateProxyProfile({
      proxyId: original.proxyId,
      expectedVersion,
      name: submission.name,
      configuration: submission.configuration,
    }));
    expectedVersion = latest.version;
  };
  const clear = async (credentialType = existingProxyCredentialType(original)) => {
    if (credentialType === undefined) throw new TypeError("stored proxy credential binding is invalid");
    latest = confirm(await commands.clearProxyCredential({
      proxyId: original.proxyId,
      expectedVersion,
      credentialType,
    }));
    expectedVersion = latest.version;
  };

  if (submission.credentialIntent.type === "keep") {
    try {
      await update();
      return finalize(latest);
    } catch (error) {
      return failed(error);
    }
  }

  if (submission.credentialIntent.type === "clear") {
    try {
      await clear(submission.credentialIntent.credentialType);
    } catch (error) {
      return failed(error);
    }
    try {
      await update();
      return finalize(latest);
    } catch (error) {
      return partial(latest, "credentialClearedConfigurationNotSaved", error);
    }
  }

  const newCredentialType = submission.credentialIntent.credential.type;
  const oldCredentialType = existingProxyCredentialType(original);
  if (oldCredentialType !== undefined && oldCredentialType !== newCredentialType) {
    try {
      await clear(oldCredentialType);
    } catch (error) {
      return failed(error);
    }
  }
  try {
    await update();
  } catch (error) {
    return latest === original ? failed(error) : partial(latest, "credentialClearedConfigurationNotSaved", error);
  }
  try {
    latest = confirm(await commands.setProxyCredential({
      proxyId: original.proxyId,
      expectedVersion,
      credential: submission.credentialIntent.credential,
    }));
    return finalize(latest);
  } catch (error) {
    return partial(latest, "configurationSavedCredentialNotSaved", error);
  }
}

export function useProxyProfileMutations(
  runMutation: ConfigurationMutationRunner,
  overrides: Partial<ProxyProfileMutationCommands> = NO_COMMAND_OVERRIDES,
): ProxyProfileMutationControls {
  const dispatch = useAppDispatch();
  const commands = useMemo(() => ({ ...DEFAULT_COMMANDS, ...overrides }), [overrides]);
  const activeRef = useRef(false);
  const mountedRef = useRef(false);
  const [saveState, setSaveState] = useState<ServerProfileMutationState<ProxyProfileSaveOutcome>>({ saving: false, error: null, outcome: null });
  const [deleteState, setDeleteState] = useState<ServerProfileMutationState<ProxyProfileDeleteOutcome>>({ saving: false, error: null, outcome: null });
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);
  const confirm = useCallback((profile: ProxyProfile) => {
    dispatch(proxyProfileUpserted(profile));
    return profile;
  }, [dispatch]);

  const saveProfile = useCallback(async (mode: ProxyEditorMode, submission: ProxyEditorSubmission) => {
    if (activeRef.current) return { status: "failed", error: BUSY_ERROR, errorCode: null } as const;
    activeRef.current = true;
    setSaveState({ saving: true, error: null, outcome: null });
    let outcome: ProxyProfileSaveOutcome;
    try {
      outcome = await runMutation(() => executeProxyProfileSave(mode, submission, commands, confirm));
    } catch (error) {
      outcome = failed(error);
    } finally {
      activeRef.current = false;
    }
    if (mountedRef.current) setSaveState({ saving: false, error: outcome.status === "saved" ? null : outcome.error, outcome });
    return outcome;
  }, [commands, confirm, runMutation]);

  const deleteProfile = useCallback(async (proxyId: ProxyId, version: number) => {
    if (activeRef.current) return { status: "failed", error: BUSY_ERROR, errorCode: null } as const;
    activeRef.current = true;
    setDeleteState({ saving: true, error: null, outcome: null });
    let outcome: ProxyProfileDeleteOutcome;
    try {
      await runMutation(() => commands.deleteProxyProfile({ proxyId, expectedVersion: version }));
      dispatch(proxyProfileRemoved(proxyId));
      outcome = { status: "deleted", proxyId };
    } catch (error) {
      outcome = { status: "failed", ...issue(error) };
    } finally {
      activeRef.current = false;
    }
    if (mountedRef.current) setDeleteState({ saving: false, error: outcome.status === "deleted" ? null : outcome.error, outcome });
    return outcome;
  }, [commands, dispatch, runMutation]);

  const removeHostKey = useCallback(async (profile: ProxyProfile) => {
    if (activeRef.current) return { status: "failed", error: BUSY_ERROR, errorCode: null } as const;
    activeRef.current = true;
    setSaveState({ saving: true, error: null, outcome: null });
    let outcome: ProxyProfileSaveOutcome;
    try {
      const updated = await runMutation(() => commands.removeProxySshHostKey({ proxyId: profile.proxyId, expectedVersion: profile.version }));
      outcome = { status: "saved", profile: confirm(updated) };
    } catch (error) {
      outcome = failed(error);
    } finally {
      activeRef.current = false;
    }
    if (mountedRef.current) setSaveState({ saving: false, error: outcome.status === "saved" ? null : outcome.error, outcome });
    return outcome;
  }, [commands, confirm, runMutation]);

  const confirmHostKey = useCallback(async (
    profile: ProxyProfile,
    prompt: Extract<SshHostKeyPrompt, { readonly kind: "unknown" }>,
  ) => {
    if (activeRef.current) return { status: "failed", error: BUSY_ERROR, errorCode: null } as const;
    activeRef.current = true;
    setSaveState({ saving: true, error: null, outcome: null });
    let outcome: ProxyProfileSaveOutcome;
    try {
      const updated = await runMutation(() => commands.confirmProxySshHostKey({
        proxyId: profile.proxyId,
        expectedVersion: profile.version,
        host: prompt.host,
        port: prompt.port,
        algorithm: prompt.algorithm,
        sha256Fingerprint: prompt.sha256Fingerprint,
      }));
      outcome = { status: "saved", profile: confirm(updated) };
    } catch (error) {
      outcome = failed(error);
    } finally {
      activeRef.current = false;
    }
    if (mountedRef.current) setSaveState({ saving: false, error: outcome.status === "saved" ? null : outcome.error, outcome });
    return outcome;
  }, [commands, confirm, runMutation]);

  const recordTest = useCallback(async (
    profile: ProxyProfile,
    status: "succeeded" | "failed",
  ): Promise<ProxyProfile | null> => {
    try {
      const updated = await runMutation(() => commands.recordProxyTest({
        proxyId: profile.proxyId,
        expectedVersion: profile.version,
        status,
      }));
      return confirm(updated);
    } catch {
      return null;
    }
  }, [commands, confirm, runMutation]);

  return {
    saveProfile,
    deleteProfile,
    removeHostKey,
    confirmHostKey,
    recordTest,
    saveState,
    deleteState,
    resetSave: () => { if (!activeRef.current) setSaveState({ saving: false, error: null, outcome: null }); },
    resetDelete: () => { if (!activeRef.current) setDeleteState({ saving: false, error: null, outcome: null }); },
  };
}
