import { describe, expect, it, vi } from "vitest";

import {
  createDraftStore,
  createTransientDraftStore,
  parseDraftKeys,
  parseStoredDraft,
} from "./drafts";
import type { DraftStore } from "./drafts";
import type { TauriIpc } from "./tauriIpc";

describe("DraftStore", () => {
  it("通过固定命令读写、迁移和删除结构化草稿", async () => {
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
    await store.transition(
      "draft-1",
      "thread-1",
      { text: "迁移草稿", tokens: [] },
    );
    await store.delete("draft-1");

    expect(invoke).toHaveBeenNthCalledWith(1, "list_draft_keys", {
      request: { keyPrefix: "window:server:" },
    });
    expect(invoke).toHaveBeenNthCalledWith(2, "load_draft", { request: { draftKey: "draft-1" } });
    expect(invoke).toHaveBeenNthCalledWith(3, "save_draft", {
      request: { draftKey: "draft-1", draft: { text: "新草稿", tokens: [] } },
    });
    expect(invoke).toHaveBeenNthCalledWith(4, "transition_draft", {
      request: {
        sourceDraftKey: "draft-1",
        targetDraftKey: "thread-1",
        draft: { text: "迁移草稿", tokens: [] },
      },
    });
    expect(invoke).toHaveBeenNthCalledWith(5, "delete_draft", { request: { draftKey: "draft-1" } });
  });

  it("串行执行已发起的保存、迁移和后续读取", async () => {
    let releaseSave!: () => void;
    const saveBlocked = new Promise<void>((resolve) => {
      releaseSave = resolve;
    });
    const stored = new Map<string, unknown>();
    const invokedCommands: string[] = [];
    const invoke = vi.fn(async (command: string, payload?: unknown) => {
      invokedCommands.push(command);
      const request = (payload as {
        readonly request: {
          readonly draftKey?: string;
          readonly sourceDraftKey?: string;
          readonly targetDraftKey?: string;
          readonly draft?: unknown;
        };
      }).request;
      if (command === "save_draft") {
        await saveBlocked;
        stored.set(request.draftKey!, request.draft);
      } else if (command === "transition_draft") {
        stored.delete(request.sourceDraftKey!);
        if (request.draft === null) {
          stored.delete(request.targetDraftKey!);
        } else {
          stored.set(request.targetDraftKey!, request.draft);
        }
      } else if (command === "load_draft") {
        return stored.get(request.draftKey!) ?? null;
      }
      return null;
    });
    const store = createDraftStore({ invoke } as Pick<TauriIpc, "invoke">);

    const save = store.save("window:server:new", { text: "已经发送的问题", tokens: [] });
    const transition = store.transition(
      "window:server:new",
      "window:server:thread",
      { text: "已经发送的问题", tokens: [] },
    );
    const load = store.load("window:server:new");

    await Promise.resolve();
    expect(invokedCommands).toEqual(["save_draft"]);
    releaseSave();

    await expect(Promise.all([save, transition, load])).resolves.toEqual([
      undefined,
      undefined,
      null,
    ]);
    expect(invokedCommands).toEqual([
      "save_draft",
      "transition_draft",
      "load_draft",
    ]);
  });

  it("空白标签草稿只保存在内存并在绑定会话时转入持久存储", async () => {
    const persistent: DraftStore = {
      listKeys: vi.fn(async () => ["main:server:thread-a"]),
      load: vi.fn(async () => null),
      save: vi.fn(async () => undefined),
      delete: vi.fn(async () => undefined),
      transition: vi.fn(async () => undefined),
    };
    const store = createTransientDraftStore(persistent);
    const transientKey = "transient:main:server:tab-a";
    const draft = {
      text: "尚未发送",
      tokens: [{ type: "mention", name: "README", path: "/workspace/README.md" }],
    } as const;

    await store.save(transientKey, draft);
    await expect(store.load(transientKey)).resolves.toEqual(draft);
    await expect(store.listKeys("transient:main:server:")).resolves.toEqual([
      transientKey,
    ]);
    expect(persistent.save).not.toHaveBeenCalled();
    expect(persistent.listKeys).not.toHaveBeenCalled();

    await store.transition(
      transientKey,
      "main:server:thread-b",
      draft,
    );

    await expect(store.load(transientKey)).resolves.toBeNull();
    expect(persistent.save).toHaveBeenCalledWith(
      "main:server:thread-b",
      draft,
    );

    await store.save(transientKey, draft);
    store.discardTransient(transientKey);
    await store.save(transientKey, { text: "延迟保存", tokens: [] });
    await expect(store.load(transientKey)).resolves.toBeNull();

    store.resetTransient(transientKey);
    await store.save(transientKey, draft);
    await expect(store.load(transientKey)).resolves.toEqual(draft);
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
