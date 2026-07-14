import { listen } from "@tauri-apps/api/event";

import type { ServerId } from "../configuration";
import { tauriIpc } from "./tauriIpc";

const TAKE_PENDING_DEEP_LINK_COMMAND = "take_pending_deep_link";
const DEEP_LINK_EVENT = "deep-link-target-pending";
const SERVER_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const THREAD_ID_PATTERN = /^[A-Za-z0-9_.:-]{1,128}$/u;

export interface DeepLinkTarget {
  readonly serverId: ServerId;
  readonly threadId?: string;
}

export type DeepLinkTargetSubscriber = (
  onTarget: (target: DeepLinkTarget) => void,
  onError: () => void,
) => Promise<() => void>;

interface DeepLinkEventApi {
  listen(
    event: string,
    handler: (event: { readonly payload: unknown }) => void,
  ): Promise<() => void>;
}

interface DeepLinkIpc {
  invoke(command: string, arguments_: Record<string, unknown>): Promise<unknown>;
}

const tauriDeepLinkEvents: DeepLinkEventApi = {
  listen(event, handler) {
    return listen<unknown>(event, handler);
  },
};

export async function subscribeDeepLinkTargets(
  onTarget: (target: DeepLinkTarget) => void,
  onError: () => void,
  ipc: DeepLinkIpc = tauriIpc,
  events: DeepLinkEventApi = tauriDeepLinkEvents,
): Promise<() => void> {
  let active = true;
  let drainTail = Promise.resolve();
  const drain = () => {
    drainTail = drainTail.then(async () => {
      if (!active) return;
      try {
        const value = await ipc.invoke(TAKE_PENDING_DEEP_LINK_COMMAND, {});
        const target = parseDeepLinkTarget(value);
        if (target !== null && active) onTarget(target);
      } catch {
        if (active) onError();
      }
    });
  };
  const unlisten = await events.listen(DEEP_LINK_EVENT, ({ payload }) => {
    if (payload === null) drain();
  });
  drain();
  await drainTail;
  return () => {
    active = false;
    unlisten();
  };
}

function parseDeepLinkTarget(value: unknown): DeepLinkTarget | null {
  if (value === null) return null;
  if (typeof value !== "object" || value === null) {
    throw new TypeError("invalid deep-link target");
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (
    !keys.every((key) => key === "serverId" || key === "threadId") ||
    keys.length < 1 ||
    keys.length > 2 ||
    typeof record.serverId !== "string" ||
    !SERVER_ID_PATTERN.test(record.serverId) ||
    (record.threadId !== undefined &&
      (typeof record.threadId !== "string" || !THREAD_ID_PATTERN.test(record.threadId)))
  ) {
    throw new TypeError("invalid deep-link target");
  }
  return Object.freeze({
    serverId: record.serverId as ServerId,
    ...(record.threadId === undefined ? {} : { threadId: record.threadId as string }),
  });
}
