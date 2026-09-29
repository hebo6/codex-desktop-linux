import { describe, expect, it, vi } from "vitest";

import {
  createDraftStore,
  createTransientDraftStore,
  parseDraftKeys,
  parseStoredDraft,
} from "./drafts";
import type { DraftStore, StoredDraft } from "./drafts";
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

  it("撤回消息经过持久化读写仍保留完整协议输入", async () => {
    let serialized: string | null = null;
    const invoke = vi.fn(async (command: string, payload?: unknown) => {
      if (command === "save_draft") {
        serialized = JSON.stringify((payload as { request: { draft: StoredDraft } }).request.draft);
      }
      if (command === "load_draft") return serialized === null ? null : JSON.parse(serialized);
      return null;
    });
    const store = createDraftStore({ invoke } as Pick<TauriIpc, "invoke">);
    const draft: StoredDraft = {
      text: "完整内容",
      tokens: [{ type: "skill", name: "检查", path: "/tmp/skill" }],
      restoredInput: [
        { type: "text", text: "完整内容", text_elements: [{ byteRange: { start: 0, end: 6 }, placeholder: "完整" }], extension: { original: true } },
        { type: "image", fileId: "file-id", detail: "original" },
        { type: "image", url: "data:image/png;base64,IMAGE", detail: "high" },
        { type: "audio", url: "data:audio/wav;base64,AUDIO" },
        { type: "localImage", path: "/tmp/image.png" },
        { type: "localAudio", path: "/tmp/audio.wav" },
        { type: "skill", name: "检查", path: "/tmp/skill", extension: "preserved" },
      ],
    };
    await store.save("draft", draft);
    await expect(store.load("draft")).resolves.toEqual(draft);
  });

  it("内存草稿保存和各方向迁移均保留撤回消息", async () => {
    const persistent: DraftStore = {
      listKeys: vi.fn(async () => []),
      load: vi.fn(async () => null),
      save: vi.fn(async () => undefined),
      delete: vi.fn(async () => undefined),
      transition: vi.fn(async () => undefined),
    };
    const store = createTransientDraftStore(persistent);
    const draft: StoredDraft = {
      text: "",
      tokens: [],
      restoredInput: [{ type: "image", fileId: "file-id", detail: "original" }],
    };
    await store.save("transient:a", draft);
    await expect(store.load("transient:a")).resolves.toEqual(draft);
    await store.transition("transient:a", "transient:b", draft);
    await expect(store.load("transient:b")).resolves.toEqual(draft);
    await store.transition("transient:b", "thread", draft);
    expect(persistent.save).toHaveBeenCalledWith("thread", draft);
    await store.transition("thread", "transient:c", draft);
    await expect(store.load("transient:c")).resolves.toEqual(draft);
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

  it.each([
    { label: "null", restoredInput: null },
    { label: "非数组", restoredInput: {} },
    { label: "未知类型", restoredInput: [{ type: "unsupported", value: "unknown" }] },
    { label: "缺少图片源", restoredInput: [{ type: "image" }] },
    { label: "音频源类型错误", restoredInput: [{ type: "audio", url: 1 }] },
    { label: "文本元素范围错误", restoredInput: [{ type: "text", text: "内容", text_elements: [{ byteRange: { start: "zero", end: 6 } }] }] },
  ])("拒绝不符合协议的已恢复输入：$label", ({ restoredInput }) => {
    expect(() => parseStoredDraft({ text: "", tokens: [], restoredInput }))
      .toThrow("invalid restored draft input");
  });
});
