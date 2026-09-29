import type { ServerId } from "../configuration";
import { tauriIpc, type TauriIpc } from "./tauriIpc";

export interface AsyncQuestionResponse {
  readonly questionKey: string;
  readonly disposition: "sent" | "ignored";
}

export interface AsyncQuestionResponseStore {
  list(
    serverId: ServerId,
    threadId: string,
  ): Promise<readonly AsyncQuestionResponse[]>;
  record(
    serverId: ServerId,
    threadId: string,
    response: AsyncQuestionResponse,
  ): Promise<void>;
}

export function createAsyncQuestionResponseStore(
  ipc: Pick<TauriIpc, "invoke"> = tauriIpc,
): AsyncQuestionResponseStore {
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
    list(serverId, threadId) {
      return enqueue(async () =>
        parseAsyncQuestionResponses(
          await ipc.invoke<unknown>("list_async_question_responses", {
            request: { serverId, threadId },
          }),
        )
      );
    },
    record(serverId, threadId, response) {
      return enqueue(async () => {
        await ipc.invoke<unknown>("record_async_question_response", {
          request: { serverId, threadId, response },
        });
      });
    },
  };
}

export const asyncQuestionResponseStore = createAsyncQuestionResponseStore();

export function parseAsyncQuestionResponses(
  value: unknown,
): readonly AsyncQuestionResponse[] {
  if (!Array.isArray(value)) {
    throw new TypeError("invalid async question responses");
  }
  return Object.freeze(value.map((entry) => {
    if (
      !isRecord(entry)
      || typeof entry.questionKey !== "string"
      || entry.questionKey.length === 0
      || (entry.disposition !== "sent" && entry.disposition !== "ignored")
      || Object.keys(entry).some((key) => key !== "questionKey" && key !== "disposition")
    ) {
      throw new TypeError("invalid async question response");
    }
    return Object.freeze({
      questionKey: entry.questionKey,
      disposition: entry.disposition,
    });
  }));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
