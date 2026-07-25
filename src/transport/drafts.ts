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

export interface TransientDraftStore extends DraftStore {
  discardTransient(draftKey: string): void;
  resetTransient(draftKey: string): void;
}

export function createTransientDraftStore(
  persistent: DraftStore,
  transientKeyPrefix = "transient:",
): TransientDraftStore {
  const transient = new Map<string, StoredDraft>();
  const discarded = new Set<string>();
  const isTransient = (key: string) => key.startsWith(transientKeyPrefix);
  return {
    discardTransient(draftKey) {
      if (!isTransient(draftKey)) {
        throw new TypeError("only transient drafts can be discarded");
      }
      discarded.add(draftKey);
      transient.delete(draftKey);
    },
    resetTransient(draftKey) {
      if (!isTransient(draftKey)) {
        throw new TypeError("only transient drafts can be reset");
      }
      discarded.delete(draftKey);
      transient.delete(draftKey);
    },
    async listKeys(keyPrefix) {
      const transientKeys = [...transient.keys()].filter((key) =>
        key.startsWith(keyPrefix)
      );
      const persistedKeys = isTransient(keyPrefix)
        ? []
        : await persistent.listKeys(keyPrefix);
      return Object.freeze([...persistedKeys, ...transientKeys]);
    },
    async load(draftKey) {
      return isTransient(draftKey)
        ? transient.get(draftKey) ?? null
        : persistent.load(draftKey);
    },
    async save(draftKey, draft) {
      if (isTransient(draftKey)) {
        if (discarded.has(draftKey)) {
          return;
        }
        transient.set(draftKey, Object.freeze({
          text: draft.text,
          tokens: Object.freeze([...draft.tokens]),
        }));
        return;
      }
      await persistent.save(draftKey, draft);
    },
    async delete(draftKey) {
      if (isTransient(draftKey)) {
        transient.delete(draftKey);
        return;
      }
      await persistent.delete(draftKey);
    },
    async transition(sourceDraftKey, targetDraftKey, draft) {
      const sourceTransient = isTransient(sourceDraftKey);
      const targetTransient = isTransient(targetDraftKey);
      if (sourceTransient && targetTransient) {
        discarded.delete(sourceDraftKey);
        discarded.delete(targetDraftKey);
        transient.delete(sourceDraftKey);
        if (draft !== null) {
          transient.set(targetDraftKey, Object.freeze({
            text: draft.text,
            tokens: Object.freeze([...draft.tokens]),
          }));
        }
        return;
      }
      if (!sourceTransient && !targetTransient) {
        await persistent.transition(sourceDraftKey, targetDraftKey, draft);
        return;
      }
      if (sourceTransient) {
        discarded.delete(sourceDraftKey);
        transient.delete(sourceDraftKey);
        if (draft === null) {
          await persistent.delete(targetDraftKey);
        } else {
          await persistent.save(targetDraftKey, draft);
        }
        return;
      }
      await persistent.delete(sourceDraftKey);
      discarded.delete(targetDraftKey);
      if (draft === null) {
        transient.delete(targetDraftKey);
      } else {
        transient.set(targetDraftKey, Object.freeze({
          text: draft.text,
          tokens: Object.freeze([...draft.tokens]),
        }));
      }
    },
  };
}

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
