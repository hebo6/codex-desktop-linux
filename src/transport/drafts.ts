import type { TurnStartParams } from "../protocol/generated";
import { tauriIpc, type TauriIpc } from "./tauriIpc";

type StructuredInput = Extract<
  TurnStartParams["input"][number],
  { type: "skill" | "mention" }
>;

export interface StoredDraft {
  readonly text: string;
  readonly tokens: readonly StructuredInput[];
}

export interface DraftStore {
  listKeys(keyPrefix: string): Promise<readonly string[]>;
  load(draftKey: string): Promise<StoredDraft | null>;
  save(draftKey: string, draft: StoredDraft): Promise<void>;
  delete(draftKey: string): Promise<void>;
  transition(
    sourceDraftKey: string,
    targetDraftKey: string,
    draft: StoredDraft | null,
  ): Promise<void>;
}

export function createDraftStore(
  ipc: Pick<TauriIpc, "invoke"> = tauriIpc,
): DraftStore {
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
    listKeys(keyPrefix) {
      return enqueue(async () => parseDraftKeys(await ipc.invoke<unknown>("list_draft_keys", {
        request: { keyPrefix },
      })));
    },
    load(draftKey) {
      return enqueue(async () => parseStoredDraft(await ipc.invoke<unknown>("load_draft", {
        request: { draftKey },
      })));
    },
    save(draftKey, draft) {
      return enqueue(async () => {
        await ipc.invoke<unknown>("save_draft", {
          request: { draftKey, draft },
        });
      });
    },
    delete(draftKey) {
      return enqueue(async () => {
        await ipc.invoke<unknown>("delete_draft", {
          request: { draftKey },
        });
      });
    },
    transition(sourceDraftKey, targetDraftKey, draft) {
      return enqueue(async () => {
        await ipc.invoke<unknown>("transition_draft", {
          request: { sourceDraftKey, targetDraftKey, draft },
        });
      });
    },
  };
}

export const draftStore = createDraftStore();

export function parseDraftKeys(value: unknown): readonly string[] {
  if (
    !Array.isArray(value) ||
    !value.every((key): key is string => typeof key === "string")
  ) {
    throw new TypeError("invalid draft keys");
  }
  return Object.freeze([...value]);
}

export function parseStoredDraft(value: unknown): StoredDraft | null {
  if (value === null) return null;
  if (!isRecord(value) || typeof value.text !== "string" || !Array.isArray(value.tokens)) {
    throw new TypeError("invalid stored draft");
  }
  const tokens = value.tokens.map(parseStructuredInput);
  return Object.freeze({ text: value.text, tokens: Object.freeze(tokens) });
}

function parseStructuredInput(value: unknown): StructuredInput {
  if (
    !isRecord(value)
    || (value.type !== "skill" && value.type !== "mention")
    || typeof value.name !== "string"
    || typeof value.path !== "string"
    || Object.keys(value).some((key) => !["type", "name", "path"].includes(key))
  ) {
    throw new TypeError("invalid stored draft token");
  }
  return Object.freeze({ type: value.type, name: value.name, path: value.path });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
