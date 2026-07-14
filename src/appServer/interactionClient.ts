import type { ServerNotification, ServerRequest } from "../protocol/generated";
import type { AppServerSession } from "./session";

type InteractionSession = Pick<
  AppServerSession,
  "registerServerRequestHandler" | "subscribeNotifications"
>;

export interface PendingInteraction {
  readonly key: string;
  readonly request: ServerRequest;
  readonly responding: boolean;
}

export interface InteractionSnapshot {
  readonly pending: readonly PendingInteraction[];
  readonly resolvedElsewhereCount: number;
}

interface DeferredInteraction {
  readonly request: ServerRequest;
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

const EMPTY_SNAPSHOT = Object.freeze({
  pending: Object.freeze([]),
  resolvedElsewhereCount: 0,
}) satisfies InteractionSnapshot;

export class AppServerInteractionClient {
  private readonly session: InteractionSession;
  private readonly releases: Array<() => void> = [];
  private readonly pendingByKey = new Map<string, DeferredInteraction>();
  private readonly listeners = new Set<() => void>();
  private snapshotValue: InteractionSnapshot = EMPTY_SNAPSHOT;
  private disposed = false;
  private resolvedElsewhereCount = 0;

  constructor(session: InteractionSession) {
    this.session = session;
    for (const method of USER_FACING_METHODS) {
      this.releases.push(session.registerServerRequestHandler(method, (request) => this.enqueue(request)));
    }
    this.releases.push(session.registerServerRequestHandler("currentTime/read", () => ({
      currentTimeAt: Math.floor(Date.now() / 1000),
    })));
    this.releases.push(session.registerServerRequestHandler("item/tool/call", () => ({
      contentItems: [],
      success: false,
    })));
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
    this.listeners.clear();
    this.snapshotValue = EMPTY_SNAPSHOT;
  }

  private enqueue(request: ServerRequest): Promise<unknown> {
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
      }))),
      resolvedElsewhereCount: this.resolvedElsewhereCount,
    });
    for (const listener of this.listeners) listener();
  }
}

function requestKey(id: string | number): string {
  return `${typeof id}:${String(id)}`;
}

function declineResponse(request: ServerRequest): unknown {
  switch (request.method) {
    case "item/commandExecution/requestApproval": return { decision: "decline" };
    case "item/fileChange/requestApproval": return { decision: "decline" };
    case "item/permissions/requestApproval": return { permissions: {}, scope: "turn" };
    case "item/tool/requestUserInput": return { answers: {} };
    case "mcpServer/elicitation/request": return { action: "decline", content: null, _meta: null };
    case "applyPatchApproval":
    case "execCommandApproval": return { decision: "denied" };
    default: return {};
  }
}
