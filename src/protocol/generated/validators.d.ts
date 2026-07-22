// 此文件由 scripts/generate-protocol-code.mjs 自动生成，请勿手动修改
// Codex app-server 上游提交：ac3da4fb1a2ad0ee2f0c867bfa81a5a3a3737f9c
import type { ErrorObject } from "ajv";

import type {
  AppsListResponse,
  ConfigReadResponse,
  ConfigRequirementsReadResponse,
  ConsumeAccountRateLimitResetCreditResponse,
  FsGetMetadataResponse,
  FsReadFileResponse,
  FuzzyFileSearchResponse,
  GetAccountRateLimitsResponse,
  GetAccountTokenUsageResponse,
  InitializeResponse,
  JSONRPCMessage,
  ModelListResponse,
  PermissionProfileListResponse,
  PluginListResponse,
  ReviewStartResponse,
  ServerNotification,
  ServerRequest,
  SkillsListResponse,
  ThreadArchiveResponse,
  ThreadCompactStartResponse,
  ThreadDeleteResponse,
  ThreadForkResponse,
  ThreadListResponse,
  ThreadReadResponse,
  ThreadResumeResponse,
  ThreadSettingsUpdateResponse,
  ThreadStartResponse,
  ThreadTurnsListResponse,
  ThreadUnarchiveResponse,
  ThreadUnsubscribeResponse,
  TurnInterruptResponse,
  TurnStartResponse,
  TurnSteerResponse,
} from "./index";

export interface StandaloneValidateFunction<T> {
  (value: unknown): value is T;
  readonly errors: readonly ErrorObject[] | null;
}

export const validateJSONRPCMessage: StandaloneValidateFunction<JSONRPCMessage>;
export const validateServerRequest: StandaloneValidateFunction<ServerRequest>;
export const validateServerNotification: StandaloneValidateFunction<ServerNotification>;
export const validateInitializeResponse: StandaloneValidateFunction<InitializeResponse>;
export const validateThreadListResponse: StandaloneValidateFunction<ThreadListResponse>;
export const validateThreadReadResponse: StandaloneValidateFunction<ThreadReadResponse>;
export const validateThreadResumeResponse: StandaloneValidateFunction<ThreadResumeResponse>;
export const validateThreadTurnsListResponse: StandaloneValidateFunction<ThreadTurnsListResponse>;
export const validateThreadUnsubscribeResponse: StandaloneValidateFunction<ThreadUnsubscribeResponse>;
export const validateThreadArchiveResponse: StandaloneValidateFunction<ThreadArchiveResponse>;
export const validateThreadUnarchiveResponse: StandaloneValidateFunction<ThreadUnarchiveResponse>;
export const validateThreadDeleteResponse: StandaloneValidateFunction<ThreadDeleteResponse>;
export const validateThreadStartResponse: StandaloneValidateFunction<ThreadStartResponse>;
export const validateThreadSettingsUpdateResponse: StandaloneValidateFunction<ThreadSettingsUpdateResponse>;
export const validateTurnStartResponse: StandaloneValidateFunction<TurnStartResponse>;
export const validateTurnSteerResponse: StandaloneValidateFunction<TurnSteerResponse>;
export const validateTurnInterruptResponse: StandaloneValidateFunction<TurnInterruptResponse>;
export const validateModelListResponse: StandaloneValidateFunction<ModelListResponse>;
export const validateSkillsListResponse: StandaloneValidateFunction<SkillsListResponse>;
export const validateFuzzyFileSearchResponse: StandaloneValidateFunction<FuzzyFileSearchResponse>;
export const validatePermissionProfileListResponse: StandaloneValidateFunction<PermissionProfileListResponse>;
export const validateConfigReadResponse: StandaloneValidateFunction<ConfigReadResponse>;
export const validateConfigRequirementsReadResponse: StandaloneValidateFunction<ConfigRequirementsReadResponse>;
export const validateAppsListResponse: StandaloneValidateFunction<AppsListResponse>;
export const validatePluginListResponse: StandaloneValidateFunction<PluginListResponse>;
export const validateThreadCompactStartResponse: StandaloneValidateFunction<ThreadCompactStartResponse>;
export const validateReviewStartResponse: StandaloneValidateFunction<ReviewStartResponse>;
export const validateThreadForkResponse: StandaloneValidateFunction<ThreadForkResponse>;
export const validateFsReadFileResponse: StandaloneValidateFunction<FsReadFileResponse>;
export const validateFsGetMetadataResponse: StandaloneValidateFunction<FsGetMetadataResponse>;
export const validateGetAccountRateLimitsResponse: StandaloneValidateFunction<GetAccountRateLimitsResponse>;
export const validateConsumeAccountRateLimitResetCreditResponse: StandaloneValidateFunction<ConsumeAccountRateLimitResetCreditResponse>;
export const validateGetAccountTokenUsageResponse: StandaloneValidateFunction<GetAccountTokenUsageResponse>;
