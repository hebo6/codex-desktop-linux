import { describe, expect, it, vi } from "vitest";

import { createDraftStore, parseDraftKeys, parseStoredDraft } from "./drafts";
import type { TauriIpc } from "./tauriIpc";

describe("DraftStore", () => {
  it("通过固定命令读写和删除结构化草稿", async () => {
    const invoke = vi.fn(async (command: string) => {
      if (command === "list_draft_keys") return ["window:server:thread-1"];
      if (command === "load_draft") {
        return {
          text: "继续",
          tokens: [{ type: "mention", name: "README", path: "/workspace/README.md" }],
        };
      }
      return null;
    });
    const store = createDraftStore({ invoke } as Pick<TauriIpc, "invoke">);

    await expect(store.listKeys("window:server:")).resolves.toEqual([
      "window:server:thread-1",
    ]);
    await expect(store.load("draft-1")).resolves.toEqual({
      text: "继续",
      tokens: [{ type: "mention", name: "README", path: "/workspace/README.md" }],
    });
    await store.save("draft-1", { text: "新草稿", tokens: [] });
    await store.delete("draft-1");

    expect(invoke).toHaveBeenNthCalledWith(1, "list_draft_keys", {
      request: { keyPrefix: "window:server:" },
    });
    expect(invoke).toHaveBeenNthCalledWith(2, "load_draft", { request: { draftKey: "draft-1" } });
    expect(invoke).toHaveBeenNthCalledWith(3, "save_draft", {
      request: { draftKey: "draft-1", draft: { text: "新草稿", tokens: [] } },
    });
    expect(invoke).toHaveBeenNthCalledWith(4, "delete_draft", { request: { draftKey: "draft-1" } });
  });

  it("拒绝带额外字段或未知类型的草稿令牌", () => {
    expect(() => parseDraftKeys(["draft-1", 2])).toThrow("invalid draft keys");
    expect(() => parseStoredDraft({
      text: "",
      tokens: [{ type: "mention", name: "x", path: "/x", secret: "hidden" }],
    })).toThrow("invalid stored draft token");
    expect(() => parseStoredDraft({ text: "", tokens: [{ type: "text", text: "x" }] }))
      .toThrow("invalid stored draft token");
  });
});
