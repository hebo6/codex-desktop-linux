import {
  isKnownServerNotificationMethod,
  isKnownServerRequestMethod,
} from "../generated";
import type {
  InitializeResponse,
  JSONRPCMessage,
  ServerNotification,
  ServerRequest,
  ThreadListResponse,
  ThreadReadResponse,
  ThreadResumeResponse,
  ThreadTurnsListResponse,
  ThreadUnsubscribeResponse,
  ThreadArchiveResponse,
  ThreadUnarchiveResponse,
  ThreadDeleteResponse,
  ThreadStartResponse,
  ThreadSettingsUpdateResponse,
  ThreadBackgroundTerminalsListResponse,
  ThreadBackgroundTerminalsTerminateResponse,
  TurnStartResponse,
  TurnSteerResponse,
  TurnInterruptResponse,
  ModelListResponse,
  SkillsListResponse,
  FuzzyFileSearchResponse,
  PermissionProfileListResponse,
  ConfigReadResponse,
  ConfigRequirementsReadResponse,
  AppsListResponse,
  PluginListResponse,
  ThreadCompactStartResponse,
  ReviewStartResponse,
  ThreadForkResponse,
  FsReadFileResponse,
  FsGetMetadataResponse,
  GetAccountRateLimitsResponse,
  ConsumeAccountRateLimitResetCreditResponse,
  GetAccountTokenUsageResponse,
} from "../generated";
import {
  validateInitializeResponse as validateInitializeResponseSchema,
  validateJSONRPCMessage as validateJSONRPCMessageSchema,
  validateServerNotification as validateServerNotificationSchema,
  validateServerRequest as validateServerRequestSchema,
  validateThreadListResponse as validateThreadListResponseSchema,
  validateThreadReadResponse as validateThreadReadResponseSchema,
  validateThreadResumeResponse as validateThreadResumeResponseSchema,
  validateThreadTurnsListResponse as validateThreadTurnsListResponseSchema,
  validateThreadUnsubscribeResponse as validateThreadUnsubscribeResponseSchema,
  validateThreadArchiveResponse as validateThreadArchiveResponseSchema,
  validateThreadUnarchiveResponse as validateThreadUnarchiveResponseSchema,
  validateThreadDeleteResponse as validateThreadDeleteResponseSchema,
  validateThreadStartResponse as validateThreadStartResponseSchema,
  validateThreadSettingsUpdateResponse as validateThreadSettingsUpdateResponseSchema,
  validateThreadBackgroundTerminalsListResponse as validateThreadBackgroundTerminalsListResponseSchema,
  validateThreadBackgroundTerminalsTerminateResponse as validateThreadBackgroundTerminalsTerminateResponseSchema,
  validateTurnStartResponse as validateTurnStartResponseSchema,
  validateTurnSteerResponse as validateTurnSteerResponseSchema,
  validateTurnInterruptResponse as validateTurnInterruptResponseSchema,
  validateModelListResponse as validateModelListResponseSchema,
  validateSkillsListResponse as validateSkillsListResponseSchema,
  validateFuzzyFileSearchResponse as validateFuzzyFileSearchResponseSchema,
  validatePermissionProfileListResponse as validatePermissionProfileListResponseSchema,
  validateConfigReadResponse as validateConfigReadResponseSchema,
  validateConfigRequirementsReadResponse as validateConfigRequirementsReadResponseSchema,
  validateAppsListResponse as validateAppsListResponseSchema,
  validatePluginListResponse as validatePluginListResponseSchema,
  validateThreadCompactStartResponse as validateThreadCompactStartResponseSchema,
  validateReviewStartResponse as validateReviewStartResponseSchema,
  validateThreadForkResponse as validateThreadForkResponseSchema,
  validateFsReadFileResponse as validateFsReadFileResponseSchema,
  validateFsGetMetadataResponse as validateFsGetMetadataResponseSchema,
  validateGetAccountRateLimitsResponse as validateGetAccountRateLimitsResponseSchema,
  validateConsumeAccountRateLimitResetCreditResponse as validateConsumeAccountRateLimitResetCreditResponseSchema,
  validateGetAccountTokenUsageResponse as validateGetAccountTokenUsageResponseSchema,
} from "../generated/validators.js";

export type ProtocolValidationStage = "parse" | "envelope" | "method" | "params";

export type ProtocolValidationCode =
  | "invalid_json"
  | "invalid_envelope"
  | "unknown_method"
  | "invalid_params";

export interface ProtocolValidationError {
  readonly code: ProtocolValidationCode;
  readonly stage: ProtocolValidationStage;
  /**
   * 不包含原始值、字段值或未知方法名，可安全写入诊断日志
   */
  readonly summary: string;
}

export type ProtocolValidationResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: ProtocolValidationError };

interface SchemaErrorSummary {
  readonly keyword: string;
  readonly schemaPath: string;
}

interface SchemaValidator<T> {
  (value: unknown): value is T;
  readonly errors: readonly SchemaErrorSummary[] | null;
}

export function parseJsonRpcMessage(serialized: string): ProtocolValidationResult<JSONRPCMessage> {
  let value: unknown;
  try {
    value = JSON.parse(serialized);
  } catch {
    return failure(
      "invalid_json",
      "parse",
      `JSON 解析失败（输入长度 ${serialized.length}，内容已隐藏）`,
    );
  }

  return validateJsonRpcMessage(value);
}

export function validateJsonRpcMessage(value: unknown): ProtocolValidationResult<JSONRPCMessage> {
  return validateWithSchema(
    value,
    validateJSONRPCMessageSchema,
    "invalid_envelope",
    "envelope",
    "JSON-RPC envelope 校验失败",
  );
}

export function validateServerRequest(value: unknown): ProtocolValidationResult<ServerRequest> {
  const envelopeResult = validateJsonRpcMessage(value);
  if (!envelopeResult.ok) {
    return envelopeResult;
  }

  const method = readMethod(envelopeResult.value);
  if (method === undefined || !isKnownServerRequestMethod(method)) {
    return failure("unknown_method", "method", "未知服务端请求方法（方法名已隐藏）");
  }

  return validateWithSchema(
    envelopeResult.value,
    validateServerRequestSchema,
    "invalid_params",
    "params",
    "服务端请求参数校验失败",
  );
}

export function validateServerNotification(
  value: unknown,
): ProtocolValidationResult<ServerNotification> {
  const envelopeResult = validateJsonRpcMessage(value);
  if (!envelopeResult.ok) {
    return envelopeResult;
  }

  const method = readMethod(envelopeResult.value);
  if (method === undefined || !isKnownServerNotificationMethod(method)) {
    return failure("unknown_method", "method", "未知服务端通知方法（方法名已隐藏）");
  }

  return validateWithSchema(
    envelopeResult.value,
    validateServerNotificationSchema,
    "invalid_params",
    "params",
    "服务端通知参数校验失败",
  );
}

export function validateInitializeResponse(
  value: unknown,
): ProtocolValidationResult<InitializeResponse> {
  return validateWithSchema(
    value,
    validateInitializeResponseSchema,
    "invalid_params",
    "params",
    "initialize 响应校验失败",
  );
}

export function validateThreadListResponse(
  value: unknown,
): ProtocolValidationResult<ThreadListResponse> {
  return validateWithSchema(
    value,
    validateThreadListResponseSchema,
    "invalid_params",
    "params",
    "thread/list 响应校验失败",
  );
}

export function validateThreadReadResponse(
  value: unknown,
): ProtocolValidationResult<ThreadReadResponse> {
  return validateWithSchema(
    value,
    validateThreadReadResponseSchema,
    "invalid_params",
    "params",
    "thread/read 响应校验失败",
  );
}

export function validateThreadResumeResponse(
  value: unknown,
): ProtocolValidationResult<ThreadResumeResponse> {
  return validateWithSchema(
    value,
    validateThreadResumeResponseSchema,
    "invalid_params",
    "params",
    "thread/resume 响应校验失败",
  );
}

export function validateThreadTurnsListResponse(
  value: unknown,
): ProtocolValidationResult<ThreadTurnsListResponse> {
  return validateWithSchema(
    value,
    validateThreadTurnsListResponseSchema,
    "invalid_params",
    "params",
    "thread/turns/list 响应校验失败",
  );
}

export function validateThreadUnsubscribeResponse(
  value: unknown,
): ProtocolValidationResult<ThreadUnsubscribeResponse> {
  return validateWithSchema(
    value,
    validateThreadUnsubscribeResponseSchema,
    "invalid_params",
    "params",
    "thread/unsubscribe 响应校验失败",
  );
}

export function validateThreadArchiveResponse(
  value: unknown,
): ProtocolValidationResult<ThreadArchiveResponse> {
  return validateWithSchema(
    value,
    validateThreadArchiveResponseSchema,
    "invalid_params",
    "params",
    "thread/archive 响应校验失败",
  );
}

export function validateThreadUnarchiveResponse(
  value: unknown,
): ProtocolValidationResult<ThreadUnarchiveResponse> {
  return validateWithSchema(
    value,
    validateThreadUnarchiveResponseSchema,
    "invalid_params",
    "params",
    "thread/unarchive 响应校验失败",
  );
}

export function validateThreadDeleteResponse(
  value: unknown,
): ProtocolValidationResult<ThreadDeleteResponse> {
  return validateWithSchema(
    value,
    validateThreadDeleteResponseSchema,
    "invalid_params",
    "params",
    "thread/delete 响应校验失败",
  );
}

export function validateThreadStartResponse(
  value: unknown,
): ProtocolValidationResult<ThreadStartResponse> {
  return validateWithSchema(value, validateThreadStartResponseSchema, "invalid_params", "params", "thread/start 响应校验失败");
}

export function validateThreadSettingsUpdateResponse(
  value: unknown,
): ProtocolValidationResult<ThreadSettingsUpdateResponse> {
  return validateWithSchema(
    value,
    validateThreadSettingsUpdateResponseSchema,
    "invalid_params",
    "params",
    "thread/settings/update 响应校验失败",
  );
}

export function validateThreadBackgroundTerminalsListResponse(
  value: unknown,
): ProtocolValidationResult<ThreadBackgroundTerminalsListResponse> {
  return validateWithSchema(
    value,
    validateThreadBackgroundTerminalsListResponseSchema,
    "invalid_params",
    "params",
    "thread/backgroundTerminals/list 响应校验失败",
  );
}

export function validateThreadBackgroundTerminalsTerminateResponse(
  value: unknown,
): ProtocolValidationResult<ThreadBackgroundTerminalsTerminateResponse> {
  return validateWithSchema(
    value,
    validateThreadBackgroundTerminalsTerminateResponseSchema,
    "invalid_params",
    "params",
    "thread/backgroundTerminals/terminate 响应校验失败",
  );
}

export function validateTurnStartResponse(
  value: unknown,
): ProtocolValidationResult<TurnStartResponse> {
  return validateWithSchema(value, validateTurnStartResponseSchema, "invalid_params", "params", "turn/start 响应校验失败");
}

export function validateTurnSteerResponse(
  value: unknown,
): ProtocolValidationResult<TurnSteerResponse> {
  return validateWithSchema(value, validateTurnSteerResponseSchema, "invalid_params", "params", "turn/steer 响应校验失败");
}

export function validateTurnInterruptResponse(
  value: unknown,
): ProtocolValidationResult<TurnInterruptResponse> {
  return validateWithSchema(value, validateTurnInterruptResponseSchema, "invalid_params", "params", "turn/interrupt 响应校验失败");
}

export function validateModelListResponse(
  value: unknown,
): ProtocolValidationResult<ModelListResponse> {
  return validateWithSchema(value, validateModelListResponseSchema, "invalid_params", "params", "model/list 响应校验失败");
}

export function validateSkillsListResponse(
  value: unknown,
): ProtocolValidationResult<SkillsListResponse> {
  return validateWithSchema(value, validateSkillsListResponseSchema, "invalid_params", "params", "skills/list 响应校验失败");
}

export function validateFuzzyFileSearchResponse(
  value: unknown,
): ProtocolValidationResult<FuzzyFileSearchResponse> {
  return validateWithSchema(value, validateFuzzyFileSearchResponseSchema, "invalid_params", "params", "fuzzyFileSearch 响应校验失败");
}

export function validatePermissionProfileListResponse(
  value: unknown,
): ProtocolValidationResult<PermissionProfileListResponse> {
  return validateWithSchema(value, validatePermissionProfileListResponseSchema, "invalid_params", "params", "permissionProfile/list 响应校验失败");
}

export function validateConfigReadResponse(
  value: unknown,
): ProtocolValidationResult<ConfigReadResponse> {
  return validateWithSchema(value, validateConfigReadResponseSchema, "invalid_params", "params", "config/read 响应校验失败");
}

export function validateConfigRequirementsReadResponse(
  value: unknown,
): ProtocolValidationResult<ConfigRequirementsReadResponse> {
  return validateWithSchema(value, validateConfigRequirementsReadResponseSchema, "invalid_params", "params", "configRequirements/read 响应校验失败");
}

export function validateAppsListResponse(
  value: unknown,
): ProtocolValidationResult<AppsListResponse> {
  return validateWithSchema(value, validateAppsListResponseSchema, "invalid_params", "params", "app/list 响应校验失败");
}

export function validatePluginListResponse(
  value: unknown,
): ProtocolValidationResult<PluginListResponse> {
  return validateWithSchema(value, validatePluginListResponseSchema, "invalid_params", "params", "plugin/list 响应校验失败");
}

export function validateThreadCompactStartResponse(
  value: unknown,
): ProtocolValidationResult<ThreadCompactStartResponse> {
  return validateWithSchema(value, validateThreadCompactStartResponseSchema, "invalid_params", "params", "thread/compact/start 响应校验失败");
}

export function validateReviewStartResponse(
  value: unknown,
): ProtocolValidationResult<ReviewStartResponse> {
  return validateWithSchema(value, validateReviewStartResponseSchema, "invalid_params", "params", "review/start 响应校验失败");
}

export function validateThreadForkResponse(
  value: unknown,
): ProtocolValidationResult<ThreadForkResponse> {
  return validateWithSchema(value, validateThreadForkResponseSchema, "invalid_params", "params", "thread/fork 响应校验失败");
}

export function validateFsReadFileResponse(
  value: unknown,
): ProtocolValidationResult<FsReadFileResponse> {
  return validateWithSchema(value, validateFsReadFileResponseSchema, "invalid_params", "params", "fs/readFile 响应校验失败");
}

export function validateFsGetMetadataResponse(
  value: unknown,
): ProtocolValidationResult<FsGetMetadataResponse> {
  return validateWithSchema(value, validateFsGetMetadataResponseSchema, "invalid_params", "params", "fs/getMetadata 响应校验失败");
}

export function validateGetAccountRateLimitsResponse(
  value: unknown,
): ProtocolValidationResult<GetAccountRateLimitsResponse> {
  return validateWithSchema(value, validateGetAccountRateLimitsResponseSchema, "invalid_params", "params", "account/rateLimits/read 响应校验失败");
}

export function validateConsumeAccountRateLimitResetCreditResponse(
  value: unknown,
): ProtocolValidationResult<ConsumeAccountRateLimitResetCreditResponse> {
  return validateWithSchema(value, validateConsumeAccountRateLimitResetCreditResponseSchema, "invalid_params", "params", "account/rateLimitResetCredit/consume 响应校验失败");
}

export function validateGetAccountTokenUsageResponse(
  value: unknown,
): ProtocolValidationResult<GetAccountTokenUsageResponse> {
  return validateWithSchema(value, validateGetAccountTokenUsageResponseSchema, "invalid_params", "params", "account/usage/read 响应校验失败");
}

function validateWithSchema<T>(
  value: unknown,
  validator: SchemaValidator<T>,
  code: ProtocolValidationCode,
  stage: ProtocolValidationStage,
  label: string,
): ProtocolValidationResult<T> {
  if (validator(value)) {
    return { ok: true, value };
  }

  return failure(code, stage, summarizeSchemaErrors(label, validator.errors));
}

function summarizeSchemaErrors(
  label: string,
  errors: readonly SchemaErrorSummary[] | null,
): string {
  if (errors === null || errors.length === 0) {
    return `${label}（原始内容已隐藏）`;
  }

  const visibleErrors = errors
    .slice(0, 3)
    .map(({ keyword, schemaPath }) => `${keyword}@${schemaPath}`)
    .join("、");
  const remainingCount = errors.length - Math.min(errors.length, 3);
  const remainingSummary = remainingCount > 0 ? `，另有 ${remainingCount} 项` : "";
  return `${label}：${visibleErrors}${remainingSummary}（原始内容已隐藏）`;
}

function readMethod(value: JSONRPCMessage): string | undefined {
  if ("method" in value && typeof value.method === "string") {
    return value.method;
  }
  return undefined;
}

function failure(
  code: ProtocolValidationCode,
  stage: ProtocolValidationStage,
  summary: string,
): ProtocolValidationResult<never> {
  return { ok: false, error: { code, stage, summary } };
}
