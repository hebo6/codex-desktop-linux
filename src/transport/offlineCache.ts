import type {
  ThreadListResponse,
  ThreadTurnsListResponse,
} from "../protocol/generated";
import {
  validateThreadListResponse,
  validateThreadTurnsListResponse,
} from "../protocol/validation";
import type { ServerId } from "../configuration";
import { tauriIpc, type TauriIpc } from "./tauriIpc";

const LOAD_THREAD_CACHE_COMMAND = "load_thread_cache";
const SAVE_THREAD_CACHE_COMMAND = "save_thread_cache";

export interface CachedRestoredThread {
  readonly metadata: ThreadListResponse["data"][number];
  readonly turns: readonly ThreadTurnsListResponse["data"][number][];
  readonly nextCursor: string | null;
}

export interface ThreadCacheSnapshot {
  readonly threads: readonly ThreadListResponse["data"][number][];
  readonly nextThreadCursor: string | null;
  readonly restoredThread: CachedRestoredThread | null;
  readonly syncedAtMs: number;
}

export interface SaveThreadCacheInput {
  readonly serverId: ServerId;
  readonly threads: readonly ThreadListResponse["data"][number][];
  readonly nextThreadCursor: string | null;
  readonly currentThreadId: string | null;
  readonly restoredThread: CachedRestoredThread | null;
}

export interface ServerThreadCache {
  load(serverId: ServerId, currentThreadId: string | null): Promise<ThreadCacheSnapshot | null>;
  save(input: SaveThreadCacheInput): Promise<void>;
}

export function createServerThreadCache(
  ipc: Pick<TauriIpc, "invoke"> = tauriIpc,
): ServerThreadCache {
  return {
    async load(serverId, currentThreadId) {
      const value = await ipc.invoke<unknown>(LOAD_THREAD_CACHE_COMMAND, {
        request: { serverId, currentThreadId },
      });
      return parseThreadCacheSnapshot(value);
    },
    async save(input) {
      await ipc.invoke<unknown>(SAVE_THREAD_CACHE_COMMAND, {
        request: stripThreadCacheTiming(input),
      });
    },
  };
}

export const serverThreadCache = createServerThreadCache();

export function parseThreadCacheSnapshot(value: unknown): ThreadCacheSnapshot | null {
  if (value === null) return null;
  if (!isRecord(value)) throw new TypeError("invalid thread cache response");
  const listValidation = validateThreadListResponse({
    data: value.threads,
    nextCursor: value.nextThreadCursor,
  });
  if (!listValidation.ok) throw new TypeError("invalid cached thread list");
  const restoredThread = parseRestoredThread(value.restoredThread);
  if (!Number.isSafeInteger(value.syncedAtMs) || (value.syncedAtMs as number) < 0) {
    throw new TypeError("invalid thread cache timestamp");
  }
  return {
    threads: Object.freeze(listValidation.value.data.map(stripThreadTiming)),
    nextThreadCursor: listValidation.value.nextCursor ?? null,
    restoredThread,
    syncedAtMs: value.syncedAtMs as number,
  };
}

function parseRestoredThread(value: unknown): CachedRestoredThread | null {
  if (value === null || value === undefined) return null;
  if (!isRecord(value)) throw new TypeError("invalid cached thread projection");
  const metadataValidation = validateThreadListResponse({ data: [value.metadata] });
  const turnsValidation = validateThreadTurnsListResponse({
    data: value.turns,
    nextCursor: value.nextCursor,
  });
  if (!metadataValidation.ok || !turnsValidation.ok) {
    throw new TypeError("invalid cached thread projection");
  }
  const metadata = metadataValidation.value.data[0];
  if (metadata === undefined) throw new TypeError("missing cached thread metadata");
  return Object.freeze({
    metadata: stripThreadTiming(metadata),
    turns: Object.freeze(turnsValidation.value.data.map(stripTurnTiming)),
    nextCursor: turnsValidation.value.nextCursor ?? null,
  });
}

function stripThreadCacheTiming(input: SaveThreadCacheInput): SaveThreadCacheInput {
  return {
    ...input,
    threads: input.threads.map(stripThreadTiming),
    restoredThread: input.restoredThread === null
      ? null
      : {
          ...input.restoredThread,
          metadata: stripThreadTiming(input.restoredThread.metadata),
          turns: input.restoredThread.turns.map(stripTurnTiming),
        },
  };
}

function stripThreadTiming(
  thread: ThreadListResponse["data"][number],
): ThreadListResponse["data"][number] {
  return {
    ...thread,
    turns: thread.turns.map(stripTurnTiming),
  };
}

function stripTurnTiming(
  turn: ThreadTurnsListResponse["data"][number],
): ThreadTurnsListResponse["data"][number] {
  const stripped = { ...turn };
  delete stripped.startedAt;
  delete stripped.completedAt;
  delete stripped.durationMs;
  return stripped;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
