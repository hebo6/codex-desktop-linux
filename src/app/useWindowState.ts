import { useEffect, useMemo, useState, useSyncExternalStore } from "react";

import type { ServerId } from "../configuration";
import {
  bindWindowServer,
  loadWindowState,
  updateWindowTabs,
  WindowStateTransportError,
} from "../transport/windowState";
import type {
  BindWindowServerRequest,
  UpdateWindowTabsRequest,
  WindowTab,
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
  readonly replaceActiveThread: (threadId: string | null) => Promise<WindowState>;
  readonly openTab: (threadId?: string | null) => Promise<WindowState>;
  readonly activateTab: (tabId: string) => Promise<WindowState>;
  readonly closeTab: (tabId: string) => Promise<WindowState>;
  readonly attachThread: (tabId: string, threadId: string) => Promise<WindowState>;
  readonly applyExternalState: (state: WindowState) => void;
}

export interface WindowStateControllerOptions {
  readonly loader?: () => Promise<WindowState>;
  readonly binder?: (request: BindWindowServerRequest) => Promise<WindowState>;
  readonly tabsUpdater?: (
    request: UpdateWindowTabsRequest,
  ) => Promise<WindowState>;
}

export type WindowStateControllerErrorCode =
  "stateUnavailable" | "operationFailed" | "serverAlreadyOpen";

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
      readonly type: "replaceActiveThread";
      readonly threadId: string | null;
    }
  | {
      readonly type: "openTab";
      readonly tab: WindowTab;
    }
  | {
      readonly type: "activateTab";
      readonly tabId: string;
    }
  | {
      readonly type: "closeTab";
      readonly tabId: string;
      readonly replacementTabId: string;
    }
  | {
      readonly type: "attachThread";
      readonly tabId: string;
      readonly threadId: string;
    };

export class WindowStateController {
  private readonly loader: () => Promise<WindowState>;
  private readonly binder: (
    request: BindWindowServerRequest,
  ) => Promise<WindowState>;
  private readonly tabsUpdater: (
    request: UpdateWindowTabsRequest,
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
    this.tabsUpdater = options.tabsUpdater ?? updateWindowTabs;
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

  readonly replaceActiveThread = (threadId: string | null): Promise<WindowState> =>
    this.enqueueMutation({ type: "replaceActiveThread", threadId });

  readonly openTab = (threadId: string | null = null): Promise<WindowState> =>
    this.enqueueMutation({
      type: "openTab",
      tab: Object.freeze({ id: crypto.randomUUID(), threadId }),
    });

  readonly activateTab = (tabId: string): Promise<WindowState> =>
    this.enqueueMutation({ type: "activateTab", tabId });

  readonly closeTab = (tabId: string): Promise<WindowState> =>
    this.enqueueMutation({
      type: "closeTab",
      tabId,
      replacementTabId: crypto.randomUUID(),
    });

  readonly attachThread = (
    tabId: string,
    threadId: string,
  ): Promise<WindowState> =>
    this.enqueueMutation({ type: "attachThread", tabId, threadId });

  readonly applyExternalState = (state: WindowState): void => {
    const current = this.authoritativeState;
    if (
      this.disposed ||
      current === null ||
      state.windowId !== current.windowId ||
      state.version <= current.version
    ) {
      return;
    }
    this.loadGeneration += 1;
    this.authoritativeState = state;
    this.publish(
      this.pendingMutationCount > 0 ? "updating" : "ready",
      state,
      null,
    );
  };

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
      } catch (error) {
        rejectOperation(
          error instanceof WindowStateControllerError
            ? error
            : new WindowStateControllerError("operationFailed"),
        );
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
    const tabsMutation =
      mutation.type === "bindServer" ? null : applyTabsMutation(previous, mutation);
    if (
      mutation.type === "bindServer"
        ? mutationMatchesState(previous, mutation)
        : tabsMutation === null
    ) {
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
          : await this.tabsUpdater({
              expectedVersion: previous.version,
              tabs: tabsMutation!.tabs,
              activeTabId: tabsMutation!.activeTabId,
            });
      assertMutationResult(previous, next, mutation);
    } catch (error) {
      if (
        error instanceof WindowStateTransportError &&
        error.code === "serverAlreadyOpen"
      ) {
        if (!this.disposed) {
          this.publish(
            this.pendingMutationCount > 1 ? "updating" : "ready",
            previous,
            null,
          );
        }
        throw new WindowStateControllerError("serverAlreadyOpen");
      }
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
    : false;
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
      replaceActiveThread: controller.replaceActiveThread,
      openTab: controller.openTab,
      activateTab: controller.activateTab,
      closeTab: controller.closeTab,
      attachThread: controller.attachThread,
      applyExternalState: controller.applyExternalState,
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
    mutation.type === "bindServer" &&
    (next.serverId ?? null) !== mutation.serverId
  ) {
    throw new WindowStateControllerError("operationFailed");
  }
  if (mutation.type !== "bindServer") {
    const expected = applyTabsMutation(previous, mutation);
    if (
      expected === null ||
      next.serverId !== previous.serverId ||
      next.activeTabId !== expected.activeTabId ||
      !sameTabs(next.tabs, expected.tabs)
    ) {
      throw new WindowStateControllerError("operationFailed");
    }
  }
}

interface TabsMutationResult {
  readonly tabs: readonly WindowTab[];
  readonly activeTabId: string;
}

function applyTabsMutation(
  state: WindowState,
  mutation: Exclude<WindowMutation, { readonly type: "bindServer" }>,
): TabsMutationResult | null {
  const activeTabId = state.activeTabId;
  if (state.serverId === undefined || activeTabId === undefined) {
    throw new WindowStateControllerError("stateUnavailable");
  }
  switch (mutation.type) {
    case "replaceActiveThread": {
      const existing = mutation.threadId === null
        ? undefined
        : state.tabs.find(({ threadId }) => threadId === mutation.threadId);
      if (existing !== undefined) {
        return existing.id === activeTabId
          ? null
          : { tabs: state.tabs, activeTabId: existing.id };
      }
      const tabs = state.tabs.map((tab) =>
        tab.id === activeTabId
          ? Object.freeze({ ...tab, threadId: mutation.threadId })
          : tab
      );
      return sameTabs(tabs, state.tabs)
        ? null
        : { tabs: Object.freeze(tabs), activeTabId };
    }
    case "openTab": {
      const existing = mutation.tab.threadId === null
        ? undefined
        : state.tabs.find(({ threadId }) => threadId === mutation.tab.threadId);
      if (existing !== undefined) {
        return existing.id === activeTabId
          ? null
          : { tabs: state.tabs, activeTabId: existing.id };
      }
      return {
        tabs: Object.freeze([...state.tabs, mutation.tab]),
        activeTabId: mutation.tab.id,
      };
    }
    case "activateTab":
      if (!state.tabs.some(({ id }) => id === mutation.tabId)) {
        throw new WindowStateControllerError("operationFailed");
      }
      return mutation.tabId === activeTabId
        ? null
        : { tabs: state.tabs, activeTabId: mutation.tabId };
    case "closeTab": {
      const index = state.tabs.findIndex(({ id }) => id === mutation.tabId);
      if (index < 0) {
        return null;
      }
      if (state.tabs.length === 1) {
        const tab = Object.freeze({
          id: mutation.replacementTabId,
          threadId: null,
        });
        return { tabs: Object.freeze([tab]), activeTabId: tab.id };
      }
      const tabs = Object.freeze(state.tabs.filter(({ id }) => id !== mutation.tabId));
      if (mutation.tabId !== activeTabId) {
        return { tabs, activeTabId };
      }
      const next = tabs[index] ?? tabs[index - 1];
      if (next === undefined) {
        throw new WindowStateControllerError("operationFailed");
      }
      return { tabs, activeTabId: next.id };
    }
    case "attachThread": {
      const source = state.tabs.find(({ id }) => id === mutation.tabId);
      if (source === undefined) {
        throw new WindowStateControllerError("operationFailed");
      }
      const existing = state.tabs.find(
        ({ id, threadId }) => id !== mutation.tabId && threadId === mutation.threadId,
      );
      if (existing !== undefined) {
        const tabs = Object.freeze(
          state.tabs.filter(({ id }) => id !== mutation.tabId),
        );
        return { tabs, activeTabId: existing.id };
      }
      if (source.threadId === mutation.threadId) {
        return null;
      }
      return {
        tabs: Object.freeze(state.tabs.map((tab) =>
          tab.id === mutation.tabId
            ? Object.freeze({ ...tab, threadId: mutation.threadId })
            : tab
        )),
        activeTabId,
      };
    }
  }
}

function sameTabs(
  left: readonly WindowTab[],
  right: readonly WindowTab[],
): boolean {
  return left.length === right.length && left.every(
    (tab, index) =>
      tab.id === right[index]?.id &&
      tab.threadId === right[index]?.threadId,
  );
}
