// 此文件由 scripts/generate-protocol-code.mjs 自动生成，请勿手动修改
// Codex app-server 上游提交：ac3da4fb1a2ad0ee2f0c867bfa81a5a3a3737f9c

/**
 * Refers to any valid JSON-RPC object that can be decoded off the wire, or encoded to be sent.
 */
export type JSONRPCMessage = JSONRPCRequest | JSONRPCNotification | JSONRPCResponse | JSONRPCError;
export type RequestId = string | number;

/**
 * A request that expects a response.
 */
export interface JSONRPCRequest {
  id: RequestId;
  method: string;
  params?: unknown;
  /**
   * Optional W3C Trace Context for distributed tracing.
   */
  trace?: W3CTraceContext | null;
  [k: string]: unknown | undefined;
}
export interface W3CTraceContext {
  traceparent?: string | null;
  tracestate?: string | null;
  [k: string]: unknown | undefined;
}
/**
 * A notification which does not expect a response.
 */
export interface JSONRPCNotification {
  method: string;
  params?: unknown;
  [k: string]: unknown | undefined;
}
/**
 * A successful (non-error) response to a request.
 */
export interface JSONRPCResponse {
  id: RequestId;
  result: unknown;
  [k: string]: unknown | undefined;
}
/**
 * A response to a request that indicates an error occurred.
 */
export interface JSONRPCError {
  error: JSONRPCErrorError;
  id: RequestId;
  [k: string]: unknown | undefined;
}
export interface JSONRPCErrorError {
  code: number;
  data?: unknown;
  message: string;
  [k: string]: unknown | undefined;
}
