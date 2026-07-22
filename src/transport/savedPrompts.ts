import { listen } from "@tauri-apps/api/event";

import { tauriIpc, type TauriIpc } from "./tauriIpc";

export interface SavedPrompt {
  readonly promptId: string;
  readonly name: string;
  readonly content: string;
  readonly version: number;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
}

export interface SavedPromptDraft {
  readonly name: string;
  readonly content: string;
}

export interface SavedPromptStore {
  list(): Promise<readonly SavedPrompt[]>;
  create(draft: SavedPromptDraft): Promise<SavedPrompt>;
  update(prompt: SavedPrompt, draft: SavedPromptDraft): Promise<SavedPrompt>;
  delete(prompt: SavedPrompt): Promise<void>;
  reorder(promptIds: readonly string[]): Promise<void>;
  subscribe?(onChange: () => void): Promise<() => void>;
}

export type SavedPromptErrorCode =
  | "invalidRequest"
  | "nameConflict"
  | "notFound"
  | "versionConflict"
  | "collectionConflict"
  | "storageUnavailable";

export class SavedPromptCommandError extends Error {
  readonly code: SavedPromptErrorCode;

  constructor(code: SavedPromptErrorCode, message: string) {
    super(message);
    this.name = "SavedPromptCommandError";
    this.code = code;
  }
}

export function createSavedPromptStore(
  ipc: Pick<TauriIpc, "invoke"> = tauriIpc,
): SavedPromptStore {
  return {
    async list() {
      return parseSavedPrompts(await invoke(ipc, "list_saved_prompts", {}));
    },
    async create(draft) {
      return parseSavedPrompt(await invoke(ipc, "create_saved_prompt", {
        request: normalizeDraft(draft),
      }));
    },
    async update(prompt, draft) {
      return parseSavedPrompt(await invoke(ipc, "update_saved_prompt", {
        request: {
          promptId: prompt.promptId,
          expectedVersion: prompt.version,
          ...normalizeDraft(draft),
        },
      }));
    },
    async delete(prompt) {
      await invoke(ipc, "delete_saved_prompt", {
        request: {
          promptId: prompt.promptId,
          expectedVersion: prompt.version,
        },
      });
    },
    async reorder(promptIds) {
      await invoke(ipc, "reorder_saved_prompts", {
        request: { promptIds: [...promptIds] },
      });
    },
    async subscribe(onChange) {
      return listen<null>("saved-prompts-changed", (event) => {
        if (event.payload === null) onChange();
      });
    },
  };
}

export const savedPromptStore = createSavedPromptStore();

export function parseSavedPrompts(value: unknown): readonly SavedPrompt[] {
  if (!Array.isArray(value)) {
    throw new TypeError("invalid saved prompts response");
  }
  const prompts = value.map(parseSavedPrompt);
  if (new Set(prompts.map(({ promptId }) => promptId)).size !== prompts.length) {
    throw new TypeError("duplicate saved prompt id");
  }
  return Object.freeze(prompts);
}

export function parseSavedPrompt(value: unknown): SavedPrompt {
  if (!isRecord(value) || Object.keys(value).some((key) => ![
    "promptId",
    "name",
    "content",
    "version",
    "createdAtMs",
    "updatedAtMs",
  ].includes(key))) {
    throw new TypeError("invalid saved prompt");
  }
  const promptId = requiredUuid(value.promptId);
  const name = requiredText(value.name, 80, true);
  const content = requiredText(value.content, 32_000, false);
  const version = requiredPositiveInteger(value.version);
  const createdAtMs = requiredTimestamp(value.createdAtMs);
  const updatedAtMs = requiredTimestamp(value.updatedAtMs);
  if (updatedAtMs < createdAtMs) {
    throw new TypeError("invalid saved prompt timestamp");
  }
  return Object.freeze({
    promptId,
    name,
    content,
    version,
    createdAtMs,
    updatedAtMs,
  });
}

async function invoke(
  ipc: Pick<TauriIpc, "invoke">,
  command: string,
  arguments_: Record<string, unknown>,
): Promise<unknown> {
  try {
    return await ipc.invoke<unknown>(command, arguments_);
  } catch (error) {
    throw parseCommandError(error);
  }
}

function normalizeDraft(draft: SavedPromptDraft): SavedPromptDraft {
  const name = draft.name.trim();
  requiredText(name, 80, true);
  requiredText(draft.content, 32_000, false);
  return { name, content: draft.content };
}

function parseCommandError(value: unknown): SavedPromptCommandError {
  if (
    isRecord(value)
    && isErrorCode(value.code)
    && typeof value.message === "string"
    && value.message.length > 0
  ) {
    return new SavedPromptCommandError(value.code, value.message);
  }
  return new SavedPromptCommandError("storageUnavailable", "常用提示词存储暂时不可用");
}

function isErrorCode(value: unknown): value is SavedPromptErrorCode {
  return [
    "invalidRequest",
    "nameConflict",
    "notFound",
    "versionConflict",
    "collectionConflict",
    "storageUnavailable",
  ].includes(String(value));
}

function requiredUuid(value: unknown): string {
  if (
    typeof value !== "string"
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)
  ) {
    throw new TypeError("invalid saved prompt id");
  }
  return value;
}

function requiredText(value: unknown, maxCharacters: number, trimmed: boolean): string {
  if (
    typeof value !== "string"
    || value.trim().length === 0
    || [...value].length > maxCharacters
    || (trimmed && value !== value.trim())
  ) {
    throw new TypeError("invalid saved prompt text");
  }
  return value;
}

function requiredPositiveInteger(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new TypeError("invalid saved prompt version");
  }
  return Number(value);
}

function requiredTimestamp(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new TypeError("invalid saved prompt timestamp");
  }
  return Number(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
