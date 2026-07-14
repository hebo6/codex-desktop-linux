import {
  validateInitializeResponse,
  validateJsonRpcMessage,
  validateServerNotification,
  validateServerRequest,
} from "../validation";
import type { ProtocolValidationResult } from "../validation";
import type {
  MethodValidationResult,
  ProtocolBoundary,
  ValidationResult,
} from "./types";

function envelopeResult<T>(result: ProtocolValidationResult<T>): ValidationResult<T> {
  return result.ok
    ? { ok: true, value: result.value }
    : { ok: false, error: result.error };
}

function methodResult<T>(
  result: ProtocolValidationResult<T>,
): MethodValidationResult<T> {
  if (result.ok) {
    return { kind: "valid", value: result.value };
  }
  return result.error.code === "unknown_method"
    ? { kind: "unknown_method", validation: result.error }
    : { kind: "invalid_params", validation: result.error };
}

/**
 * 将固化 Schema 生成的运行时校验器适配为路由核心的传输无关边界
 */
export const schemaProtocolBoundary: ProtocolBoundary = {
  validateMessage(value) {
    return envelopeResult(validateJsonRpcMessage(value));
  },
  validateInitializeResponse(value) {
    return envelopeResult(validateInitializeResponse(value));
  },
  validateServerNotification(message) {
    return methodResult(validateServerNotification(message));
  },
  validateServerRequest(message) {
    return methodResult(validateServerRequest(message));
  },
};
