import { tauriIpc, type TauriIpc } from "./tauriIpc";

const OPEN_COMMAND = "open_protocol_debug_window";
const SUBSCRIBE_COMMAND = "subscribe_protocol_trace";
const UNSUBSCRIBE_COMMAND = "unsubscribe_protocol_trace";
const CLEAR_COMMAND = "clear_protocol_trace";
const MAX_BATCH_ENTRIES = 5_000;
const MAX_PAYLOAD_CHARACTERS = 1_100_000;

export type ProtocolTraceDirection = "inbound" | "outbound";
export type ProtocolTraceScope = "configured" | "connectionTest";
export type ProtocolMessageKind =
  | "request"
  | "response"
  | "notification"
  | "unknown";

export interface ProtocolTraceEntry {
  readonly sequence: number;
  readonly timestampMs: number;
  readonly direction: ProtocolTraceDirection;
  readonly scope: ProtocolTraceScope;
  readonly serverId?: string;
  readonly connectionId: string;
  readonly transport: "localStdio" | "remoteWebSocket";
  readonly connectionPath: string;
  readonly windowLabel?: string;
  readonly kind: ProtocolMessageKind;
  readonly method?: string;
  readonly requestId?: string;
  readonly durationMs?: number;
  readonly payload: string;
  readonly originalBytes: number;
  readonly truncated: boolean;
}

export interface ProtocolTraceBatch {
  readonly reset: boolean;
  readonly entries: readonly ProtocolTraceEntry[];
  readonly oldestSequence?: number;
  readonly retainedCount: number;
  readonly retainedBytes: number;
  readonly evictedCount: number;
}

export type ProtocolTraceSubscriber = (
  onBatch: (batch: ProtocolTraceBatch) => void,
) => Promise<() => void>;

export async function openProtocolDebugWindow(
  ipc: TauriIpc = tauriIpc,
): Promise<void> {
  await ipc.invoke<void>(OPEN_COMMAND, {});
}

export async function clearProtocolTrace(
  ipc: TauriIpc = tauriIpc,
): Promise<void> {
  await ipc.invoke<void>(CLEAR_COMMAND, {});
}

export async function subscribeProtocolTrace(
  onBatch: (batch: ProtocolTraceBatch) => void,
  ipc: TauriIpc = tauriIpc,
): Promise<() => void> {
  let active = true;
  const eventChannel = ipc.createEventChannel((event) => {
    if (!active) return;
    const batch = parseProtocolTraceBatch(event);
    if (batch === null) return;
    try {
      onBatch(batch);
    } catch {
      // 视图回调不能中断后续只读追踪消息
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
  if (!positiveSafeInteger(subscriptionId)) {
    active = false;
    throw new TypeError("协议追踪订阅返回了无效标识");
  }
  return () => {
    if (!active) return;
    active = false;
    void ipc.invoke<void>(UNSUBSCRIBE_COMMAND, {
      request: { subscriptionId },
    }).catch(() => undefined);
  };
}

export function parseProtocolTraceBatch(
  value: unknown,
): ProtocolTraceBatch | null {
  const batch = record(value);
  if (
    batch === null ||
    !hasExactKeys(
      batch,
      batch.oldestSequence === undefined
        ? [
            "reset",
            "entries",
            "retainedCount",
            "retainedBytes",
            "evictedCount",
          ]
        : [
            "reset",
            "entries",
            "oldestSequence",
            "retainedCount",
            "retainedBytes",
            "evictedCount",
          ],
    ) ||
    typeof batch.reset !== "boolean" ||
    !Array.isArray(batch.entries) ||
    batch.entries.length > MAX_BATCH_ENTRIES ||
    !nonNegativeSafeInteger(batch.retainedCount) ||
    !nonNegativeSafeInteger(batch.retainedBytes) ||
    !nonNegativeSafeInteger(batch.evictedCount) ||
    (batch.oldestSequence !== undefined &&
      !positiveSafeInteger(batch.oldestSequence))
  ) {
    return null;
  }

  const entries: ProtocolTraceEntry[] = [];
  let previousSequence = 0;
  for (const value of batch.entries) {
    const entry = parseProtocolTraceEntry(value);
    if (entry === null || entry.sequence <= previousSequence) {
      return null;
    }
    entries.push(entry);
    previousSequence = entry.sequence;
  }
  return Object.freeze({
    reset: batch.reset,
    entries: Object.freeze(entries),
    ...(batch.oldestSequence === undefined
      ? {}
      : { oldestSequence: batch.oldestSequence }),
    retainedCount: batch.retainedCount,
    retainedBytes: batch.retainedBytes,
    evictedCount: batch.evictedCount,
  });
}

function parseProtocolTraceEntry(value: unknown): ProtocolTraceEntry | null {
  const entry = record(value);
  if (entry === null) return null;
  const optionalKeys = [
    ["serverId", entry.serverId],
    ["windowLabel", entry.windowLabel],
    ["method", entry.method],
    ["requestId", entry.requestId],
    ["durationMs", entry.durationMs],
  ] as const;
  const expectedKeys = [
    "sequence",
    "timestampMs",
    "direction",
    "scope",
    "connectionId",
    "transport",
    "connectionPath",
    "kind",
    "payload",
    "originalBytes",
    "truncated",
    ...optionalKeys
      .filter(([, optional]) => optional !== undefined)
      .map(([key]) => key),
  ];
  if (
    !hasExactKeys(entry, expectedKeys) ||
    !positiveSafeInteger(entry.sequence) ||
    !nonNegativeSafeInteger(entry.timestampMs) ||
    (entry.direction !== "inbound" && entry.direction !== "outbound") ||
    (entry.scope !== "configured" && entry.scope !== "connectionTest") ||
    typeof entry.connectionId !== "string" ||
    entry.connectionId.length === 0 ||
    entry.connectionId.length > 128 ||
    (entry.transport !== "localStdio" &&
      entry.transport !== "remoteWebSocket") ||
    typeof entry.connectionPath !== "string" ||
    entry.connectionPath.length === 0 ||
    entry.connectionPath.length > 64 ||
    !isMessageKind(entry.kind) ||
    typeof entry.payload !== "string" ||
    entry.payload.length > MAX_PAYLOAD_CHARACTERS ||
    !nonNegativeSafeInteger(entry.originalBytes) ||
    typeof entry.truncated !== "boolean" ||
    !optionalString(entry.serverId, 64) ||
    !optionalString(entry.windowLabel, 128) ||
    !optionalString(entry.method, 512) ||
    !optionalString(entry.requestId, 512) ||
    (entry.durationMs !== undefined &&
      (typeof entry.durationMs !== "number" ||
        !Number.isFinite(entry.durationMs) ||
        entry.durationMs < 0))
  ) {
    return null;
  }
  return Object.freeze({
    sequence: entry.sequence,
    timestampMs: entry.timestampMs,
    direction: entry.direction,
    scope: entry.scope,
    ...(entry.serverId === undefined
      ? {}
      : { serverId: entry.serverId as string }),
    connectionId: entry.connectionId,
    transport: entry.transport,
    connectionPath: entry.connectionPath,
    ...(entry.windowLabel === undefined
      ? {}
      : { windowLabel: entry.windowLabel as string }),
    kind: entry.kind,
    ...(entry.method === undefined
      ? {}
      : { method: entry.method as string }),
    ...(entry.requestId === undefined
      ? {}
      : { requestId: entry.requestId as string }),
    ...(entry.durationMs === undefined
      ? {}
      : { durationMs: entry.durationMs as number }),
    payload: entry.payload,
    originalBytes: entry.originalBytes,
    truncated: entry.truncated,
  });
}

function isMessageKind(value: unknown): value is ProtocolMessageKind {
  return value === "request" ||
    value === "response" ||
    value === "notification" ||
    value === "unknown";
}

function optionalString(value: unknown, maximum: number): boolean {
  return value === undefined ||
    (typeof value === "string" && value.length > 0 && value.length <= maximum);
}

function positiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && typeof value === "number" && value > 0;
}

function nonNegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && typeof value === "number" && value >= 0;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(value);
  return actual.length === expected.length &&
    expected.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}
