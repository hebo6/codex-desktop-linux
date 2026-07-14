import { useEffect, useMemo, useState, useSyncExternalStore } from "react";

import type { ServerId } from "../configuration";
import {
  bindWindowServer,
  loadWindowState,
  updateWindowSession,
} from "../transport/windowState";
import type {
  BindWindowServerRequest,
  UpdateWindowSessionRequest,
  WindowState,
} from "../transport/windowState";

export const WINDOW_STATE_ERROR_SUMMARY = "无法读取或保存窗口状态，请重试";

export type WindowStateStatus =
  "idle" | "loading" | "ready" | "updating" | "error";

export interface WindowStateSnapshot {
  readonly status: WindowStateStatus;
  readonly windowState: WindowState | null;
  readonly error: string | null;
}

export interface WindowStateControls extends WindowStateSnapshot {
  readonly reload: () => void;
  readonly bindServer: (serverId: ServerId | null) => Promise<WindowState>;
  readonly updateSession: (
    currentThreadId: string | null,
    draftKey: string | null,
  ) => Promise<WindowState>;
}

export interface WindowStateControllerOptions {
  readonly loader?: () => Promise<WindowState>;
  readonly binder?: (request: BindWindowServerRequest) => Promise<WindowState>;
  readonly sessionUpdater?: (
    request: UpdateWindowSessionRequest,
  ) => Promise<WindowState>;
}

export type WindowStateControllerErrorCode =
  "stateUnavailable" | "operationFailed";

export class WindowStateControllerError extends Error {
  readonly code: WindowStateControllerErrorCode;

  constructor(code: WindowStateControllerErrorCode) {
    super(`Window state operation failed: ${code}`);
    this.name = "WindowStateControllerError";
    this.code = code;
  }
}

const IDLE_SNAPSHOT = Object.freeze({
  status: "idle",
  windowState: null,
  error: null,
}) satisfies WindowStateSnapshot;

const DEFAULT_OPTIONS = Object.freeze(
  {},
) satisfies WindowStateControllerOptions;

type WindowMutation =
  | {
      readonly type: "bindServer";
      readonly serverId: ServerId | null;
    }
  | {
      readonly type: "updateSession";
      readonly currentThreadId: string | null;
      readonly draftKey: string | null;
    };

export class WindowStateController {
  private readonly loader: () => Promise<WindowState>;
  private readonly binder: (
    request: BindWindowServerRequest,
  ) => Promise<WindowState>;
  private readonly sessionUpdater: (
    request: UpdateWindowSessionRequest,
  ) => Promise<WindowState>;
  private readonly listeners = new Set<() => void>();

  private snapshotValue: WindowStateSnapshot = IDLE_SNAPSHOT;
  private authoritativeState: WindowState | null = null;
  private loadGeneration = 0;
  private pendingMutationCount = 0;
  private mutationTail: Promise<void> = Promise.resolve();
  private retainCount = 0;
  private releaseVersion = 0;
  private disposed = false;

  constructor(options: WindowStateControllerOptions = DEFAULT_OPTIONS) {
    this.loader = options.loader ?? loadWindowState;
    this.binder = options.binder ?? bindWindowServer;
    this.sessionUpdater = options.sessionUpdater ?? updateWindowSession;
  }

  readonly getSnapshot = (): WindowStateSnapshot => this.snapshotValue;

  readonly subscribe = (listener: () => void): (() => void) => {
    if (this.disposed) {
      return () => undefined;
    }
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  readonly reload = (): void => {
    if (this.disposed || this.pendingMutationCount > 0) {
      return;
    }

    const generation = ++this.loadGeneration;
    this.publish("loading", this.snapshotValue.windowState, null);

    let load: Promise<WindowState>;
    try {
      load = this.loader();
    } catch {
      this.finishLoadFailure(generation);
      return;
    }
    void load.then(
      (state) => this.finishLoad(generation, state),
      () => this.finishLoadFailure(generation),
    );
  };

  readonly bindServer = (serverId: ServerId | null): Promise<WindowState> =>
    this.enqueueMutation({ type: "bindServer", serverId });

  readonly updateSession = (
    currentThreadId: string | null,
    draftKey: string | null,
  ): Promise<WindowState> =>
    this.enqueueMutation({
      type: "updateSession",
      currentThreadId,
      draftKey,
    });

  retain(): () => void {
    if (this.disposed) {
      return () => undefined;
    }
    this.retainCount += 1;
    this.releaseVersion += 1;
    if (this.snapshotValue.status === "idle") {
      this.reload();
    }

    let released = false;
    return () => {
      if (released || this.disposed) {
        return;
      }
      released = true;
      this.retainCount -= 1;
      const releaseVersion = ++this.releaseVersion;
      queueMicrotask(() => {
        if (
          !this.disposed &&
          this.retainCount === 0 &&
          releaseVersion === this.releaseVersion
        ) {
          this.dispose();
        }
      });
    };
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.loadGeneration += 1;
    this.listeners.clear();
  }

  private enqueueMutation(mutation: WindowMutation): Promise<WindowState> {
    if (this.disposed || this.authoritativeState === null) {
      return Promise.reject(new WindowStateControllerError("stateUnavailable"));
    }
    if (
      this.pendingMutationCount === 0 &&
      mutationMatchesState(this.authoritativeState, mutation)
    ) {
      return Promise.resolve(this.authoritativeState);
    }

    this.pendingMutationCount += 1;
    this.loadGeneration += 1;
    this.publish("updating", this.snapshotValue.windowState, null);

    let resolveOperation!: (state: WindowState) => void;
    let rejectOperation!: (error: WindowStateControllerError) => void;
    const operation = new Promise<WindowState>((resolve, reject) => {
      resolveOperation = resolve;
      rejectOperation = reject;
    });
    const run = async (): Promise<void> => {
      try {
        const state = await this.executeMutation(mutation);
        resolveOperation(state);
      } catch {
        rejectOperation(new WindowStateControllerError("operationFailed"));
      } finally {
        this.pendingMutationCount -= 1;
      }
    };
    this.mutationTail = this.mutationTail.then(run, run);
    return operation;
  }

  private async executeMutation(
    mutation: WindowMutation,
  ): Promise<WindowState> {
    const previous = this.authoritativeState;
    if (this.disposed || previous === null) {
      throw new WindowStateControllerError("stateUnavailable");
    }
    if (mutationMatchesState(previous, mutation)) {
      if (!this.disposed) {
        this.publish(
          this.pendingMutationCount > 1 ? "updating" : "ready",
          previous,
          null,
        );
      }
      return previous;
    }

    let next: WindowState;
    try {
      next =
        mutation.type === "bindServer"
          ? await this.binder({
              expectedVersion: previous.version,
              serverId: mutation.serverId,
            })
          : await this.sessionUpdater({
              expectedVersion: previous.version,
              currentThreadId: mutation.currentThreadId,
              draftKey: mutation.draftKey,
            });
      assertMutationResult(previous, next, mutation);
    } catch {
      this.authoritativeState = null;
      if (!this.disposed) {
        this.publish(
          "error",
          this.snapshotValue.windowState,
          WINDOW_STATE_ERROR_SUMMARY,
        );
      }
      throw new WindowStateControllerError("operationFailed");
    }

    this.authoritativeState = next;
    if (!this.disposed) {
      this.publish(
        this.pendingMutationCount > 1 ? "updating" : "ready",
        next,
        null,
      );
    }
    return next;
  }

  private finishLoad(generation: number, state: WindowState): void {
    if (this.disposed || generation !== this.loadGeneration) {
      return;
    }
    this.authoritativeState = state;
    this.publish("ready", state, null);
  }

  private finishLoadFailure(generation: number): void {
    if (this.disposed || generation !== this.loadGeneration) {
      return;
    }
    this.authoritativeState = null;
    this.publish(
      "error",
      this.snapshotValue.windowState,
      WINDOW_STATE_ERROR_SUMMARY,
    );
  }

  private publish(
    status: WindowStateStatus,
    windowState: WindowState | null,
    error: string | null,
  ): void {
    if (
      this.snapshotValue.status === status &&
      this.snapshotValue.windowState === windowState &&
      this.snapshotValue.error === error
    ) {
      return;
    }
    this.snapshotValue = Object.freeze({ status, windowState, error });
    for (const listener of this.listeners) {
      listener();
    }
  }
}

function mutationMatchesState(
  state: WindowState,
  mutation: WindowMutation,
): boolean {
  return mutation.type === "bindServer"
    ? (state.serverId ?? null) === mutation.serverId
    : (state.currentThreadId ?? null) === mutation.currentThreadId &&
        (state.draftKey ?? null) === mutation.draftKey;
}

export function useWindowState(
  options: WindowStateControllerOptions = DEFAULT_OPTIONS,
): WindowStateControls {
  const [controller] = useState(() => new WindowStateController(options));
  const snapshot = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  );

  useEffect(() => controller.retain(), [controller]);

  return useMemo(
    () => ({
      ...snapshot,
      reload: controller.reload,
      bindServer: controller.bindServer,
      updateSession: controller.updateSession,
    }),
    [controller, snapshot],
  );
}

function assertMutationResult(
  previous: WindowState,
  next: WindowState,
  mutation: WindowMutation,
): void {
  if (
    next.windowId !== previous.windowId ||
    next.version !== previous.version + 1 ||
    next.updatedAtMs < previous.updatedAtMs
  ) {
    throw new WindowStateControllerError("operationFailed");
  }
  if (
    mutation.type === "updateSession" &&
    (next.serverId !== previous.serverId ||
      (next.currentThreadId ?? null) !== mutation.currentThreadId ||
      (next.draftKey ?? null) !== mutation.draftKey)
  ) {
    throw new WindowStateControllerError("operationFailed");
  }
  if (
    mutation.type === "bindServer" &&
    (next.serverId ?? null) !== mutation.serverId
  ) {
    throw new WindowStateControllerError("operationFailed");
  }
}
