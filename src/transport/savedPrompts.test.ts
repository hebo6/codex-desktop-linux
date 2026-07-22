import { describe, expect, it, vi } from "vitest";

import {
  createSavedPromptStore,
  parseSavedPrompt,
  SavedPromptCommandError,
  type SavedPrompt,
} from "./savedPrompts";
import type { TauriIpc } from "./tauriIpc";

const PROMPT: SavedPrompt = {
  promptId: "11111111-1111-4111-8111-111111111111",
  name: "代码审查",
  content: "审查当前修改",
  version: 1,
  createdAtMs: 10,
  updatedAtMs: 10,
};

describe("SavedPromptStore", () => {
  it("通过固定命令完成增删改查与排序", async () => {
    const invoke = vi.fn(async (command: string) => command === "list_saved_prompts"
      ? [PROMPT]
      : command === "create_saved_prompt" || command === "update_saved_prompt"
        ? PROMPT
        : null);
    const store = createSavedPromptStore({ invoke } as Pick<TauriIpc, "invoke">);

    await expect(store.list()).resolves.toEqual([PROMPT]);
    await store.create({ name: " 代码审查 ", content: "审查当前修改" });
    await store.update(PROMPT, { name: "严格审查", content: "保留空白\n" });
    await store.delete(PROMPT);
    await store.reorder([PROMPT.promptId]);

    expect(invoke.mock.calls).toEqual([
      ["list_saved_prompts", {}],
      ["create_saved_prompt", { request: { name: "代码审查", content: "审查当前修改" } }],
      ["update_saved_prompt", { request: {
        promptId: PROMPT.promptId,
        expectedVersion: 1,
        name: "严格审查",
        content: "保留空白\n",
      } }],
      ["delete_saved_prompt", { request: { promptId: PROMPT.promptId, expectedVersion: 1 } }],
      ["reorder_saved_prompts", { request: { promptIds: [PROMPT.promptId] } }],
    ]);
  });

  it("严格校验返回值并保留稳定错误码", async () => {
    expect(() => parseSavedPrompt({ ...PROMPT, name: " 代码审查" }))
      .toThrow("invalid saved prompt text");
    expect(() => parseSavedPrompt({ ...PROMPT, extra: true }))
      .toThrow("invalid saved prompt");

    const store = createSavedPromptStore({
      invoke: vi.fn(async () => Promise.reject({
        code: "versionConflict",
        message: "常用提示词已在其他窗口中修改",
      })),
    });
    await expect(store.list()).rejects.toMatchObject({
      code: "versionConflict",
    } satisfies Partial<SavedPromptCommandError>);
  });
});
