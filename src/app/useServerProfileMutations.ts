import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type {
  ServerEditorMode,
  ServerEditorSubmission,
} from "../components/serverEditorModel";
import {
  existingServerCredentialType,
  hasServerCredentialBindingChanged,
} from "../components/serverEditorModel";
import {
  ConfigurationCommandError,
  type ConfigurationCommandErrorCode,
  type ServerId,
  type ServerProfile,
} from "../configuration";
import {
  serverProfileRemoved,
  serverProfileUpserted,
} from "../store/configurationSlice";
import { useAppDispatch } from "../store/hooks";
import {
  clearServerCredential,
  createServerProfile,
  deleteServerProfile,
  setServerCredential,
  updateServerProfile,
} from "../transport/configuration";

export type ConfigurationMutationRunner = <Result>(
  mutation: () => Promise<Result>,
) => Promise<Result>;

export interface ServerProfileMutationCommands {
  readonly createServerProfile: typeof createServerProfile;
  readonly updateServerProfile: typeof updateServerProfile;
  readonly deleteServerProfile: typeof deleteServerProfile;
  readonly setServerCredential: typeof setServerCredential;
  readonly clearServerCredential: typeof clearServerCredential;
}

export type ServerProfileMutationDispatch = (
  action:
    | ReturnType<typeof serverProfileUpserted>
    | ReturnType<typeof serverProfileRemoved>,
) => unknown;

export type ServerProfileSaveDataEffect =
  | "configurationSavedCredentialNotSaved"
  | "credentialClearedConfigurationNotSaved";

export type ServerProfileSaveOutcome =
  | {
      readonly status: "saved";
      readonly profile: ServerProfile;
    }
  | {
      readonly status: "partiallySaved";
      readonly profile: ServerProfile;
      readonly dataEffect: ServerProfileSaveDataEffect;
      readonly error: string;
      readonly errorCode: ConfigurationCommandErrorCode | null;
    }
  | {
      readonly status: "failed";
      readonly error: string;
      readonly errorCode: ConfigurationCommandErrorCode | null;
    };

export type ServerProfileDeleteOutcome =
  | {
      readonly status: "deleted";
      readonly serverId: ServerId;
    }
  | {
      readonly status: "failed";
      readonly error: string;
      readonly errorCode: ConfigurationCommandErrorCode | null;
    };

export interface ServerProfileMutationState<Outcome> {
  readonly saving: boolean;
  readonly error: string | null;
  readonly outcome: Outcome | null;
}

export interface ServerProfileMutationControls {
  readonly saveProfile: (
    mode: ServerEditorMode,
    submission: ServerEditorSubmission,
  ) => Promise<ServerProfileSaveOutcome>;
  readonly deleteProfile: (
    serverId: ServerId,
    version: number,
  ) => Promise<ServerProfileDeleteOutcome>;
  readonly saveState: ServerProfileMutationState<ServerProfileSaveOutcome>;
  readonly deleteState: ServerProfileMutationState<ServerProfileDeleteOutcome>;
  readonly resetSave: () => void;
  readonly resetDelete: () => void;
}

interface MutationIssue {
  readonly code: ConfigurationCommandErrorCode | null;
  readonly summary: string;
}

interface SaveExecutionOptions {
  readonly mode: ServerEditorMode;
  readonly submission: ServerEditorSubmission;
  readonly commands: ServerProfileMutationCommands;
  readonly dispatch: ServerProfileMutationDispatch;
}

interface DeleteExecutionOptions {
  readonly serverId: ServerId;
  readonly version: number;
  readonly commands: ServerProfileMutationCommands;
  readonly dispatch: ServerProfileMutationDispatch;
}

const CONFIGURATION_ERROR_SUMMARIES = {
  invalidServerName: "服务器名称无效，请检查后重试",
  invalidProxyName: "代理名称无效，请检查后重试",
  invalidConfigurationVersion: "服务器配置版本无效，请重新加载后重试",
  invalidExecutablePath: "服务器可执行文件路径无效",
  invalidWorkingDirectory: "服务器默认工作目录无效",
  invalidSshPrivateKeyPath: "SSH 私钥路径无效",
  invalidServerArguments: "服务器启动参数无效",
  invalidNonSensitiveEnvironment: "服务器普通环境变量无效",
  invalidNonSensitiveHeaders: "服务器普通请求头无效",
  invalidWebSocketUrl: "WebSocket 地址无效",
  invalidProxyUrl: "代理地址无效",
  invalidPlaintextConfirmation: "使用明文 WebSocket 前需要明确确认",
  invalidTlsCertificatePolicy: "TLS 证书策略无效",
  invalidConnectTimeout: "连接超时时间无效",
  invalidProxyHost: "代理主机无效",
  invalidProxyPort: "代理端口无效",
  invalidProxyUsername: "代理用户名无效",
  invalidSshKeepAliveInterval: "SSH 保活间隔无效",
  invalidSshKeepAliveFailures: "SSH 保活失败次数无效",
  invalidSshHostKeyRecord: "SSH 主机密钥记录无效",
  serverNameConflict: "已存在同名服务器，请更换名称",
  proxyNameConflict: "已存在同名代理，请更换名称",
  serverNotFound: "服务器配置已不存在，请重新加载",
  proxyNotFound: "所选代理已不存在，请重新选择",
  serverVersionConflict: "服务器配置已被其他操作修改，请重新加载后重试",
  proxyVersionConflict: "代理配置已被其他操作修改，请重新加载后重试",
  proxyReferenced: "代理仍被服务器引用，无法删除",
  serverInUse:
    "服务器正在被窗口使用，请关闭相关窗口或将这些窗口切换到其他服务器",
  credentialChangeRequired: "当前修改需要明确更新或清除已保存凭据",
  credentialConfigurationMismatch: "凭据与当前服务器配置不匹配",
  invalidCredentialValue: "凭据内容无效，请检查后重试",
  invalidSensitiveEnvironment: "敏感环境变量无效，请检查后重试",
  credentialServiceUnavailable: "系统凭据服务不可用，请检查系统密钥环",
  credentialServiceLocked: "系统凭据服务已锁定，请解锁后重试",
  credentialServiceTimedOut: "系统凭据服务响应超时，请重试",
  credentialPromptDismissed: "凭据访问确认已取消",
  credentialAccessDenied: "系统拒绝访问凭据服务",
  credentialNotConfigured: "当前服务器尚未配置所需凭据，请重新填写",
  credentialNotFound: "已保存的凭据不存在，请重新填写",
  credentialRecordInvalid: "已保存的凭据记录无效，请重新填写",
  credentialStorageFailed: "系统未能完成凭据存储操作，请重试",
  sshHostKeyRemovalRequired: "修改连接端点前需要先移除 SSH 主机密钥",
  sshHostKeyNotFound: "已保存的 SSH 主机密钥不存在",
  configurationCorrupt: "本地服务器配置已损坏，无法完成操作",
  configurationDatabaseFailed: "本地配置数据库操作失败，请重试",
  configurationCommandFailed: "服务器配置操作失败，请重试",
} satisfies Readonly<Record<ConfigurationCommandErrorCode, string>>;

const UNKNOWN_ERROR_SUMMARY = "服务器配置操作失败，请重试";
const BUSY_ERROR_SUMMARY = "正在处理另一项服务器配置操作，请稍候";
const UNMOUNTED_ERROR_SUMMARY = "当前页面已关闭，操作未执行";
const INVALID_CREATE_INTENT_SUMMARY = "新建服务器时不能清除已保存凭据";
const INVALID_STORED_CREDENTIAL_SUMMARY =
  "已保存的凭据状态与服务器配置不一致，请重新加载";

const IDLE_SAVE_STATE: ServerProfileMutationState<ServerProfileSaveOutcome> = {
  saving: false,
  error: null,
  outcome: null,
};

const IDLE_DELETE_STATE: ServerProfileMutationState<ServerProfileDeleteOutcome> =
  {
    saving: false,
    error: null,
    outcome: null,
  };

const DEFAULT_COMMANDS: ServerProfileMutationCommands = {
  createServerProfile,
  updateServerProfile,
  deleteServerProfile,
  setServerCredential,
  clearServerCredential,
};

const NO_COMMAND_OVERRIDES: Partial<ServerProfileMutationCommands> =
  Object.freeze({});

function issueFromUnknown(error: unknown): MutationIssue {
  if (error instanceof ConfigurationCommandError) {
    return {
      code: error.code,
      summary: CONFIGURATION_ERROR_SUMMARIES[error.code],
    };
  }
  return { code: null, summary: UNKNOWN_ERROR_SUMMARY };
}

function failedSave(error: unknown): ServerProfileSaveOutcome {
  const issue = issueFromUnknown(error);
  return {
    status: "failed",
    error: issue.summary,
    errorCode: issue.code,
  };
}

function failedDelete(error: unknown): ServerProfileDeleteOutcome {
  const issue = issueFromUnknown(error);
  return {
    status: "failed",
    error: issue.summary,
    errorCode: issue.code,
  };
}

function partialSave(
  profile: ServerProfile,
  dataEffect: ServerProfileSaveDataEffect,
  error: unknown,
): ServerProfileSaveOutcome {
  const issue = issueFromUnknown(error);
  const prefix =
    dataEffect === "configurationSavedCredentialNotSaved"
      ? "服务器配置已保存，但新凭据未保存"
      : "服务器凭据已清除，但配置修改未保存";
  return {
    status: "partiallySaved",
    profile,
    dataEffect,
    error: `${prefix}。${issue.summary}`,
    errorCode: issue.code,
  };
}

function confirmProfile(
  dispatch: ServerProfileMutationDispatch,
  profile: ServerProfile,
): ServerProfile {
  dispatch(serverProfileUpserted(profile));
  return profile;
}

async function executeCreate({
  submission,
  commands,
  dispatch,
}: Omit<SaveExecutionOptions, "mode">): Promise<ServerProfileSaveOutcome> {
  if (submission.credentialIntent.type === "clear") {
    return {
      status: "failed",
      error: INVALID_CREATE_INTENT_SUMMARY,
      errorCode: null,
    };
  }

  let created: ServerProfile;
  try {
    created = confirmProfile(
      dispatch,
      await commands.createServerProfile({
        name: submission.name,
        configuration: submission.configuration,
      }),
    );
  } catch (error) {
    return failedSave(error);
  }

  if (submission.credentialIntent.type === "keep") {
    return { status: "saved", profile: created };
  }
  try {
    const profile = confirmProfile(
      dispatch,
      await commands.setServerCredential({
        serverId: created.serverId,
        expectedVersion: created.version,
        credential: submission.credentialIntent.credential,
      }),
    );
    return { status: "saved", profile };
  } catch (error) {
    return partialSave(created, "configurationSavedCredentialNotSaved", error);
  }
}

async function executeEdit({
  mode,
  submission,
  commands,
  dispatch,
}: SaveExecutionOptions & {
  readonly mode: Extract<ServerEditorMode, { readonly type: "edit" }>;
}): Promise<ServerProfileSaveOutcome> {
  const original = mode.profile;
  const update = async (expectedVersion: number): Promise<ServerProfile> =>
    confirmProfile(
      dispatch,
      await commands.updateServerProfile({
        serverId: original.serverId,
        expectedVersion,
        name: submission.name,
        configuration: submission.configuration,
      }),
    );

  if (submission.credentialIntent.type === "keep") {
    try {
      return { status: "saved", profile: await update(original.version) };
    } catch (error) {
      return failedSave(error);
    }
  }

  if (submission.credentialIntent.type === "clear") {
    let cleared: ServerProfile;
    try {
      cleared = confirmProfile(
        dispatch,
        await commands.clearServerCredential({
          serverId: original.serverId,
          expectedVersion: original.version,
          credentialType: submission.credentialIntent.credentialType,
        }),
      );
    } catch (error) {
      return failedSave(error);
    }
    try {
      return { status: "saved", profile: await update(cleared.version) };
    } catch (error) {
      return partialSave(
        cleared,
        "credentialClearedConfigurationNotSaved",
        error,
      );
    }
  }

  let expectedVersion = original.version;
  let updatedProfile: ServerProfile;
  if (
    original.credentialConfigured &&
    hasServerCredentialBindingChanged(original, submission.configuration)
  ) {
    const credentialType = existingServerCredentialType(mode);
    if (credentialType === undefined) {
      return {
        status: "failed",
        error: INVALID_STORED_CREDENTIAL_SUMMARY,
        errorCode: null,
      };
    }
    let cleared: ServerProfile;
    try {
      cleared = confirmProfile(
        dispatch,
        await commands.clearServerCredential({
          serverId: original.serverId,
          expectedVersion,
          credentialType,
        }),
      );
      expectedVersion = cleared.version;
    } catch (error) {
      return failedSave(error);
    }

    try {
      updatedProfile = await update(expectedVersion);
      expectedVersion = updatedProfile.version;
    } catch (error) {
      return partialSave(
        cleared,
        "credentialClearedConfigurationNotSaved",
        error,
      );
    }
  } else {
    try {
      updatedProfile = await update(expectedVersion);
      expectedVersion = updatedProfile.version;
    } catch (error) {
      return failedSave(error);
    }
  }

  try {
    const profile = confirmProfile(
      dispatch,
      await commands.setServerCredential({
        serverId: original.serverId,
        expectedVersion,
        credential: submission.credentialIntent.credential,
      }),
    );
    return { status: "saved", profile };
  } catch (error) {
    return partialSave(
      updatedProfile,
      "configurationSavedCredentialNotSaved",
      error,
    );
  }
}

export async function executeServerProfileSave({
  mode,
  submission,
  commands,
  dispatch,
}: SaveExecutionOptions): Promise<ServerProfileSaveOutcome> {
  if (mode.type === "create") {
    return executeCreate({ submission, commands, dispatch });
  }
  return executeEdit({ mode, submission, commands, dispatch });
}

export async function executeServerProfileDelete({
  serverId,
  version,
  commands,
  dispatch,
}: DeleteExecutionOptions): Promise<ServerProfileDeleteOutcome> {
  try {
    await commands.deleteServerProfile({
      serverId,
      expectedVersion: version,
    });
    dispatch(serverProfileRemoved(serverId));
    return { status: "deleted", serverId };
  } catch (error) {
    return failedDelete(error);
  }
}

function outcomeError(
  outcome: ServerProfileSaveOutcome | ServerProfileDeleteOutcome,
): string | null {
  return outcome.status === "saved" || outcome.status === "deleted"
    ? null
    : outcome.error;
}

function unavailableSave(error: string): ServerProfileSaveOutcome {
  return { status: "failed", error, errorCode: null };
}

function unavailableDelete(error: string): ServerProfileDeleteOutcome {
  return { status: "failed", error, errorCode: null };
}

export function useServerProfileMutations(
  runMutation: ConfigurationMutationRunner,
  commandOverrides: Partial<ServerProfileMutationCommands> = NO_COMMAND_OVERRIDES,
): ServerProfileMutationControls {
  const dispatch = useAppDispatch();
  const [saveState, setSaveState] =
    useState<ServerProfileMutationState<ServerProfileSaveOutcome>>(
      IDLE_SAVE_STATE,
    );
  const [deleteState, setDeleteState] =
    useState<ServerProfileMutationState<ServerProfileDeleteOutcome>>(
      IDLE_DELETE_STATE,
    );
  const mountedRef = useRef(false);
  const activeOperationRef = useRef<"save" | "delete" | null>(null);
  const commands = useMemo<ServerProfileMutationCommands>(
    () => ({ ...DEFAULT_COMMANDS, ...commandOverrides }),
    [commandOverrides],
  );

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const saveProfile = useCallback(
    async (
      mode: ServerEditorMode,
      submission: ServerEditorSubmission,
    ): Promise<ServerProfileSaveOutcome> => {
      if (!mountedRef.current) {
        return unavailableSave(UNMOUNTED_ERROR_SUMMARY);
      }
      if (activeOperationRef.current !== null) {
        return unavailableSave(BUSY_ERROR_SUMMARY);
      }

      activeOperationRef.current = "save";
      setSaveState({ saving: true, error: null, outcome: null });
      let outcome: ServerProfileSaveOutcome;
      try {
        outcome = await runMutation(() =>
          executeServerProfileSave({
            mode,
            submission,
            commands,
            dispatch,
          }),
        );
      } catch (error) {
        outcome = failedSave(error);
      } finally {
        activeOperationRef.current = null;
      }

      if (mountedRef.current) {
        setSaveState({
          saving: false,
          error: outcomeError(outcome),
          outcome,
        });
      }
      return outcome;
    },
    [commands, dispatch, runMutation],
  );

  const deleteProfile = useCallback(
    async (
      serverId: ServerId,
      version: number,
    ): Promise<ServerProfileDeleteOutcome> => {
      if (!mountedRef.current) {
        return unavailableDelete(UNMOUNTED_ERROR_SUMMARY);
      }
      if (activeOperationRef.current !== null) {
        return unavailableDelete(BUSY_ERROR_SUMMARY);
      }

      activeOperationRef.current = "delete";
      setDeleteState({ saving: true, error: null, outcome: null });
      let outcome: ServerProfileDeleteOutcome;
      try {
        outcome = await runMutation(() =>
          executeServerProfileDelete({
            serverId,
            version,
            commands,
            dispatch,
          }),
        );
      } catch (error) {
        outcome = failedDelete(error);
      } finally {
        activeOperationRef.current = null;
      }

      if (mountedRef.current) {
        setDeleteState({
          saving: false,
          error: outcomeError(outcome),
          outcome,
        });
      }
      return outcome;
    },
    [commands, dispatch, runMutation],
  );

  const resetSave = useCallback(() => {
    if (mountedRef.current && activeOperationRef.current !== "save") {
      setSaveState(IDLE_SAVE_STATE);
    }
  }, []);
  const resetDelete = useCallback(() => {
    if (mountedRef.current && activeOperationRef.current !== "delete") {
      setDeleteState(IDLE_DELETE_STATE);
    }
  }, []);

  return {
    saveProfile,
    deleteProfile,
    saveState,
    deleteState,
    resetSave,
    resetDelete,
  };
}
