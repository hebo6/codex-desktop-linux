import type {
  InitializeResponse,
  JSONRPCMessage,
  ServerNotification,
  ServerRequest,
} from "../generated";

export type RpcRequestId = string | number;

export type ValidationResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error?: RpcValidationDiagnostic };

export interface RpcValidationDiagnostic {
  readonly code: string;
  readonly stage: string;
  /** 不得包含原始消息、字段值或未知方法名 */
  readonly summary: string;
}

export type MethodValidationResult<T> =
  | { readonly kind: "valid"; readonly value: T }
  | {
      readonly kind: "unknown_method";
      readonly validation?: RpcValidationDiagnostic;
    }
  | {
      readonly kind: "invalid_params";
      readonly validation?: RpcValidationDiagnostic;
    };

export interface ProtocolBoundary {
  validateMessage(value: unknown): ValidationResult<JSONRPCMessage>;
  validateInitializeResponse(
    value: unknown,
  ): ValidationResult<InitializeResponse>;
  validateServerNotification(
    message: JSONRPCMessage,
  ): MethodValidationResult<ServerNotification>;
  validateServerRequest(
    message: JSONRPCMessage,
  ): MethodValidationResult<ServerRequest>;
}

export interface RpcWriter {
  write(message: JSONRPCMessage): Promise<void>;
}

export type ResultValidator<T> = (value: unknown) => ValidationResult<T>;

export type RequestStage = "queued" | "writing" | "pending" | "settled";

export interface RequestHandle<T> {
  readonly epoch: number;
  readonly id: RpcRequestId;
  readonly stage: RequestStage;
  readonly result: Promise<T>;
}

export interface SendRequestOptions<T> {
  readonly method: string;
  readonly params?: unknown;
  readonly validateResult: ResultValidator<T>;
}

export type ServerRequestHandler = (
  request: ServerRequest,
) => unknown | Promise<unknown>;

export type ServerNotificationHandler = (
  notification: ServerNotification,
) => void | Promise<void>;

export type RpcDiagnosticCode =
  | "invalid_message"
  | "stale_epoch_message"
  | "stale_response"
  | "unknown_response"
  | "unexpected_response_stage"
  | "invalid_response_result"
  | "unknown_notification"
  | "invalid_notification"
  | "notification_handler_failed"
  | "unknown_server_request"
  | "invalid_server_request"
  | "unimplemented_server_request"
  | "server_request_handler_failed"
  | "write_failed";

export interface RpcDiagnostic {
  readonly code: RpcDiagnosticCode;
  readonly epoch: number;
  readonly direction: "inbound" | "outbound";
  readonly method?: string;
  readonly requestId?: RpcRequestId;
  readonly errorCode?: number;
  readonly validation?: RpcValidationDiagnostic;
}

export interface RpcRouterOptions {
  readonly boundary: ProtocolBoundary;
  readonly queueCapacity: number;
  readonly onDiagnostic?: (diagnostic: RpcDiagnostic) => void;
}

export interface RpcDiagnosticCounts {
  readonly unknownNotifications: number;
  readonly unknownServerRequests: number;
  readonly staleResponses: number;
  readonly unknownResponses: number;
}
