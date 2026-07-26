import type { ServerId } from "../configuration";
import { tauriIpc, type TauriIpc } from "./tauriIpc";

export interface PendingThreadResult {
  readonly threadId: string;
  readonly turnId: string;
}

export interface PendingThreadResultStore {
  list(serverId: ServerId): Promise<readonly PendingThreadResult[]>;
  record(
    serverId: ServerId,
    threadId: string,
    turnId: string,
  ): Promise<void>;
  acknowledge(
    serverId: ServerId,
    threadId: string,
    turnId: string,
  ): Promise<void>;
  clear(serverId: ServerId, threadId: string): Promise<void>;
}

export function createPendingThreadResultStore(
  ipc: Pick<TauriIpc, "invoke"> = tauriIpc,
): PendingThreadResultStore {
  let operationTail = Promise.resolve();
  const enqueue = <Result>(operation: () => Promise<Result>): Promise<Result> => {
    const result = operationTail.then(operation);
    operationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };
  return {
    list(serverId) {
      return enqueue(async () =>
        parsePendingThreadResults(
          await ipc.invoke<unknown>("list_pending_thread_results", {
            request: { serverId },
          }),
        )
      );
    },
    record(serverId, threadId, turnId) {
      return enqueue(async () => {
        await ipc.invoke<unknown>("record_pending_thread_result", {
          request: { serverId, threadId, turnId },
        });
      });
    },
    acknowledge(serverId, threadId, turnId) {
      return enqueue(async () => {
        await ipc.invoke<unknown>("acknowledge_pending_thread_result", {
          request: { serverId, threadId, turnId },
        });
      });
    },
    clear(serverId, threadId) {
      return enqueue(async () => {
        await ipc.invoke<unknown>("clear_pending_thread_result", {
          request: { serverId, threadId },
        });
      });
    },
  };
}

export const pendingThreadResultStore = createPendingThreadResultStore();

export function parsePendingThreadResults(
  value: unknown,
): readonly PendingThreadResult[] {
  if (!Array.isArray(value)) {
    throw new TypeError("invalid pending thread results");
  }
  return Object.freeze(value.map((entry) => {
    if (
      !isRecord(entry)
      || typeof entry.threadId !== "string"
      || entry.threadId.length === 0
      || typeof entry.turnId !== "string"
      || entry.turnId.length === 0
      || Object.keys(entry).some((key) => key !== "threadId" && key !== "turnId")
    ) {
      throw new TypeError("invalid pending thread result");
    }
    return Object.freeze({
      threadId: entry.threadId,
      turnId: entry.turnId,
    });
  }));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
