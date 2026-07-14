import type { ServerId } from "../configuration";
import { tauriIpc, type TauriIpc } from "./tauriIpc";

const SUBSCRIBE_COMMAND = "subscribe_configured_server_statuses";
const UNSUBSCRIBE_COMMAND = "unsubscribe_configured_server_statuses";
const SERVER_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const MAX_STATUS_COUNT = 1_024;

export type ConfiguredServerStatusStage =
  | "resolvingTarget"
  | "connectingProxy"
  | "proxyAuthentication"
  | "establishingTunnel"
  | "targetTls"
  | "webSocketHandshake";

export interface ConfiguredServerStatus {
  readonly serverId: ServerId;
  readonly phase: "connecting" | "ready";
  readonly stage?: ConfiguredServerStatusStage;
}

export type ConfiguredServerStatusSubscriber = (
  onChange: (statuses: readonly ConfiguredServerStatus[]) => void,
) => Promise<() => void>;

export async function subscribeConfiguredServerStatuses(
  onChange: (statuses: readonly ConfiguredServerStatus[]) => void,
  ipc: TauriIpc = tauriIpc,
): Promise<() => void> {
  let active = true;
  const eventChannel = ipc.createEventChannel((event) => {
    if (!active) return;
    const statuses = parseConfiguredServerStatuses(event);
    if (statuses === null) return;
    try {
      onChange(statuses);
    } catch {
      // 视图回调异常不能中断后续权威状态推送
    }
  });
  let subscriptionId: number;
  try {
    subscriptionId = await ipc.invoke<number>(SUBSCRIBE_COMMAND, {
      events: eventChannel.channel,
    });
  } catch (error) {
    active = false;
    throw error;
  }
  if (!Number.isSafeInteger(subscriptionId) || subscriptionId < 1) {
    active = false;
    throw new TypeError("连接状态订阅返回了无效标识");
  }
  return () => {
    if (!active) return;
    active = false;
    void ipc.invoke<void>(UNSUBSCRIBE_COMMAND, {
      request: { subscriptionId },
    }).catch(() => undefined);
  };
}

export function parseConfiguredServerStatuses(
  value: unknown,
): readonly ConfiguredServerStatus[] | null {
  const event = record(value);
  if (
    event === null ||
    !hasExactKeys(event, ["statuses"]) ||
    !Array.isArray(event.statuses) ||
    event.statuses.length > MAX_STATUS_COUNT
  ) {
    return null;
  }
  const statuses: ConfiguredServerStatus[] = [];
  const seen = new Set<string>();
  for (const value of event.statuses) {
    const status = record(value);
    if (
      status === null ||
      typeof status.serverId !== "string" ||
      !SERVER_ID_PATTERN.test(status.serverId) ||
      (status.phase !== "connecting" && status.phase !== "ready") ||
      seen.has(status.serverId)
    ) {
      return null;
    }
    const stage = status.stage;
    if (status.phase === "ready") {
      if (!hasExactKeys(status, ["serverId", "phase"])) return null;
      statuses.push(Object.freeze({
        serverId: status.serverId as ServerId,
        phase: "ready",
      }));
    } else {
      if (
        !hasExactKeys(
          status,
          stage === undefined ? ["serverId", "phase"] : ["serverId", "phase", "stage"],
        ) ||
        (stage !== undefined && !isStage(stage))
      ) {
        return null;
      }
      statuses.push(Object.freeze({
        serverId: status.serverId as ServerId,
        phase: "connecting",
        ...(stage === undefined ? {} : { stage }),
      }));
    }
    seen.add(status.serverId);
  }
  return Object.freeze(statuses);
}

function isStage(value: unknown): value is ConfiguredServerStatusStage {
  return value === "resolvingTarget" ||
    value === "connectingProxy" ||
    value === "proxyAuthentication" ||
    value === "establishingTunnel" ||
    value === "targetTls" ||
    value === "webSocketHandshake";
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function hasExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => key in value);
}
