import type { ServerNotification, ServerRequest } from "../protocol/generated";
import { KNOWN_SERVER_REQUEST_METHODS } from "../protocol/generated";
import { RpcServerRequestError } from "../protocol/rpc";
import type { AppServerSession } from "./session";

type InteractionSession = Pick<
  AppServerSession,
  "registerServerRequestHandler" | "subscribeNotifications"
>;

export interface PendingInteraction {
  readonly key: string;
  readonly request: ServerRequest;
  readonly responding: boolean;
  readonly threadId: string;
}

export interface InteractionSnapshot {
  readonly pending: readonly PendingInteraction[];
  readonly resolvedElsewhereCount: number;
  readonly failures: readonly ServerRequestFailure[];
}

export interface ServerRequestFailure {
  readonly key: string;
  readonly method: ServerRequest["method"];
  readonly reason: "dynamic_tool_unregistered" | "external_auth_unavailable" | "attestation_unavailable";
  readonly message: string;
  readonly threadId: string | null;
}

interface DeferredInteraction {
  readonly request: UserFacingRequest;
  readonly resolve: (response: unknown) => void;
  responding: boolean;
}

const USER_FACING_METHODS = [
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
  "item/permissions/requestApproval",
  "item/tool/requestUserInput",
  "mcpServer/elicitation/request",
  "applyPatchApproval",
  "execCommandApproval",
] as const;

type UserFacingRequest = Extract<ServerRequest, { method: (typeof USER_FACING_METHODS)[number] }>;

const MAX_FAILURES = 100;

const FAILURE_MESSAGES: Record<ServerRequestFailure["reason"], string> = {
  dynamic_tool_unregistered: "服务端请求了客户端动态工具，但此客户端尚未注册动态工具",
  external_auth_unavailable: "无法刷新外部认证令牌：此客户端没有宿主认证提供者，请重新登录服务端账户",
  attestation_unavailable: "无法生成客户端证明：此客户端不具备设备证明能力",
};

const EMPTY_SNAPSHOT = Object.freeze({
  pending: Object.freeze([]),
  resolvedElsewhereCount: 0,
  failures: Object.freeze([]),
}) satisfies InteractionSnapshot;

export class AppServerInteractionClient {
  private readonly session: InteractionSession;
  private readonly releases: Array<() => void> = [];
  private readonly pendingByKey = new Map<string, DeferredInteraction>();
  private readonly listeners = new Set<() => void>();
  private snapshotValue: InteractionSnapshot = EMPTY_SNAPSHOT;
  private disposed = false;
  private resolvedElsewhereCount = 0;
  private failures: readonly ServerRequestFailure[] = Object.freeze([]);

  constructor(session: InteractionSession) {
    this.session = session;
    for (const method of KNOWN_SERVER_REQUEST_METHODS) {
      this.releases.push(session.registerServerRequestHandler(method, (request) => this.handleRequest(request)));
    }
    this.releases.push(session.subscribeNotifications((notification) => {
      this.handleNotification(notification);
    }));
  }

  readonly getSnapshot = (): InteractionSnapshot => this.snapshotValue;

  readonly subscribe = (listener: () => void): (() => void) => {
    if (this.disposed) return () => undefined;
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  respond(key: string, response: unknown): boolean {
    const pending = this.pendingByKey.get(key);
    if (pending === undefined || pending.responding || this.disposed) return false;
    pending.responding = true;
    pending.resolve(response);
    this.publish();
    return true;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const release of this.releases.splice(0)) release();
    for (const pending of this.pendingByKey.values()) {
      pending.resolve(declineResponse(pending.request));
    }
    this.pendingByKey.clear();
    this.failures = Object.freeze([]);
    this.listeners.clear();
    this.snapshotValue = EMPTY_SNAPSHOT;
  }

  private handleRequest(request: ServerRequest): unknown | Promise<unknown> {
    switch (request.method) {
      case "item/commandExecution/requestApproval":
      case "item/fileChange/requestApproval":
      case "item/permissions/requestApproval":
      case "item/tool/requestUserInput":
      case "mcpServer/elicitation/request":
      case "applyPatchApproval":
      case "execCommandApproval":
        return this.enqueue(request);
      case "currentTime/read":
        return { currentTimeAt: Math.floor(Date.now() / 1000) };
      case "item/tool/call":
        return this.rejectUnsupported(request, "dynamic_tool_unregistered", request.params.threadId);
      case "account/chatgptAuthTokens/refresh":
        return this.rejectUnsupported(request, "external_auth_unavailable", null);
      case "attestation/generate":
        return this.rejectUnsupported(request, "attestation_unavailable", null);
      default: {
        const unhandled: never = request;
        throw new TypeError(`Unhandled server request: ${String(unhandled)}`);
      }
    }
  }

  private rejectUnsupported(
    request: ServerRequest,
    reason: ServerRequestFailure["reason"],
    threadId: string | null,
  ): never {
    const message = FAILURE_MESSAGES[reason];
    this.failures = Object.freeze([...this.failures, Object.freeze({
      key: requestKey(request.id), method: request.method, reason, message, threadId,
    })].slice(-MAX_FAILURES));
    this.publish();
    throw new RpcServerRequestError(-32601, message);
  }

  private enqueue(request: UserFacingRequest): Promise<unknown> {
    if (this.disposed) return Promise.resolve(declineResponse(request));
    const key = requestKey(request.id);
    const existing = this.pendingByKey.get(key);
    if (existing !== undefined) {
      existing.resolve(declineResponse(existing.request));
      this.pendingByKey.delete(key);
    }
    return new Promise((resolve) => {
      this.pendingByKey.set(key, { request, resolve, responding: false });
      this.publish();
    });
  }

  private handleNotification(notification: ServerNotification): void {
    if (notification.method !== "serverRequest/resolved") return;
    const key = requestKey(notification.params.requestId);
    const pending = this.pendingByKey.get(key);
    if (pending === undefined) return;
    if (!pending.responding) {
      this.resolvedElsewhereCount += 1;
      pending.resolve(declineResponse(pending.request));
    }
    this.pendingByKey.delete(key);
    this.publish();
  }

  private publish(): void {
    this.snapshotValue = Object.freeze({
      pending: Object.freeze([...this.pendingByKey.entries()].map(([key, value]) => Object.freeze({
        key,
        request: value.request,
        responding: value.responding,
        threadId: requestThreadId(value.request),
      }))),
      resolvedElsewhereCount: this.resolvedElsewhereCount,
      failures: this.failures,
    });
    for (const listener of this.listeners) listener();
  }
}

function requestThreadId(request: UserFacingRequest): string {
  switch (request.method) {
    case "item/commandExecution/requestApproval":
    case "item/fileChange/requestApproval":
    case "item/permissions/requestApproval":
    case "item/tool/requestUserInput":
    case "mcpServer/elicitation/request":
      return request.params.threadId;
    case "applyPatchApproval":
    case "execCommandApproval":
      return request.params.conversationId;
  }
}

function requestKey(id: string | number): string {
  return `${typeof id}:${String(id)}`;
}

function declineResponse(request: UserFacingRequest): unknown {
  switch (request.method) {
    case "item/commandExecution/requestApproval": return { decision: "decline" };
    case "item/fileChange/requestApproval": return { decision: "decline" };
    case "item/permissions/requestApproval": return { permissions: {}, scope: "turn" };
    case "item/tool/requestUserInput": return { answers: {} };
    case "mcpServer/elicitation/request": return { action: "decline", content: null, _meta: null };
    case "applyPatchApproval":
    case "execCommandApproval": return {
      decision: { denied: { rejection: "用户拒绝了请求" } },
    };
  }
}
