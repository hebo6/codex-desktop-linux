import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";

import { ServerEventStore, type QueuedSubmission } from "../appServer/serverEventState";
import { Composer } from "../components/Composer";
import { ThreadQueuePanel } from "../components/ThreadQueuePanel";
import type { DraftStore, StoredDraft } from "../transport/drafts";
import { useQueueMessageEditing } from "./useQueueMessageEditing";
import type { DraftAttachment } from "./useTabAttachments";

const ENTRY: QueuedSubmission = {
  id: "queue-1", clientUserMessageId: "message-1", input: [
    { type: "text", text: "检查结果", text_elements: [{ byteRange: { start: 0, end: 6 } }] },
    { type: "image", fileId: "server-image", detail: "original" },
    { type: "mention", name: "说明", path: "/workspace/readme.md" },
  ],
};

async function setup(expanded = true, activeTurn = false) {
  const store = new ServerEventStore();
  store.hydrateQueue("thread-1", 0, [ENTRY]);
  let resolveDelete!: (value: { deleted: boolean }) => void;
  const deletion = new Promise<{ deleted: boolean }>((resolve) => { resolveDelete = resolve; });
  const client = { deleteQueuedSubmission: vi.fn(() => ({ epoch: 1, id: 1, stage: "pending" as const, result: deletion })) };
  const drafts = new Map<string, StoredDraft>();
  const draftStore: DraftStore = {
    listKeys: vi.fn(async () => [...drafts.keys()]),
    load: vi.fn(async (key) => drafts.get(key) ?? null),
    save: vi.fn(async (key, draft) => { drafts.set(key, draft); }),
    delete: vi.fn(async (key) => { drafts.delete(key); }),
    transition: vi.fn(async (source, target, draft) => {
      drafts.delete(source);
      if (draft === null) drafts.delete(target);
      else drafts.set(target, draft);
    }),
  };
  const onQueue = vi.fn(async (_input: QueuedSubmission["input"]) => true);
  const onSend = vi.fn(async () => true);
  const onRunShellCommand = vi.fn(async () => true);
  function Harness() {
    const attachmentDraft = useState<readonly DraftAttachment[]>([]);
    const editing = useQueueMessageEditing({ client, threadId: "thread-1", draftKey: "draft-1", draftStore });
    return <Composer
      activeTurn={activeTurn}
      attachmentDraft={attachmentDraft}
      cwd="/workspace"
      draftKey="draft-1"
      draftStore={draftStore}
      error={null}
      queueEdit={editing.request}
      onQueueEditApplied={editing.onApplied}
      onQueueEditAvailabilityChange={editing.onAvailabilityChange}
      onQueue={onQueue}
      onSend={onSend}
      onRunShellCommand={onRunShellCommand}
      onStop={async () => true}
      showProjectPicker={false}
      stopping={false}
      submitting={editing.pending}
      accessoryPanel={<ThreadQueuePanel client={client} store={store} threadId="thread-1" canEdit={editing.available} onEdit={editing.edit} />}
    />;
  }
  const view = await act(async () => render(<Harness />));
  if (!expanded) fireEvent.click(screen.getByRole("button", { name: /^待发送队列/u }));
  return { ...view, store, client, drafts, draftStore, onQueue, onSend, onRunShellCommand, resolveDelete };
}

describe("队列移回与输入框协作", () => {
  it.each([
    { trigger: "按钮", activeTurn: false, ctrlKey: false, action: "发送" },
    { trigger: "Alt+↑", activeTurn: false, ctrlKey: false, action: "发送" },
    { trigger: "按钮", activeTurn: true, ctrlKey: false, action: "追加" },
    { trigger: "Alt+↑", activeTurn: true, ctrlKey: false, action: "追加" },
    { trigger: "按钮", activeTurn: true, ctrlKey: true, action: "排队发送" },
    { trigger: "Alt+↑", activeTurn: true, ctrlKey: true, action: "排队发送" },
  ])("通过 $trigger 移回后按普通规则$action，完整保留输入", async ({ trigger, activeTurn, ctrlKey, action }) => {
    const h = await setup(trigger === "按钮", activeTurn);
    const input = screen.getByRole<HTMLTextAreaElement>("textbox", { name: "任务输入" });
    await waitFor(() => expect(input).toBeEnabled());
    if (trigger === "按钮") {
      const edit = screen.getByRole("button", { name: "将排队消息 1 移回输入框" });
      await waitFor(() => expect(edit).toBeEnabled());
      fireEvent.click(edit);
    } else {
      fireEvent.keyDown(input, { key: "ArrowUp", altKey: true });
    }
    expect(h.client.deleteQueuedSubmission).toHaveBeenCalledExactlyOnceWith("thread-1", ENTRY.id);
    expect(input).toBeDisabled();
    expect(input).toHaveValue("");
    expect(h.drafts.size).toBe(0);
    // A queue-change notification can arrive before the delete response.
    act(() => {
      h.store.consume({ method: "thread/queue/changed", params: { threadId: "thread-1" } });
      h.store.hydrateQueue("thread-1", 1, []);
    });
    await act(async () => h.resolveDelete({ deleted: true }));
    await waitFor(() => expect(input).toHaveValue("检查结果"));
    await waitFor(() => expect(input).toHaveFocus());
    expect(input.selectionStart).toBe(input.value.length);
    expect(input.selectionEnd).toBe(input.value.length);
    expect(h.drafts.get("draft-1")?.restoredInput).toEqual(ENTRY.input);
    expect(screen.getByRole("button", { name: action })).toBeEnabled();
    fireEvent.keyDown(input, { key: "Enter", ctrlKey });
    if (ctrlKey) {
      await waitFor(() => expect(h.onQueue).toHaveBeenCalledExactlyOnceWith(ENTRY.input));
      expect(h.onSend).not.toHaveBeenCalled();
    } else {
      await waitFor(() => expect(h.onSend).toHaveBeenCalledExactlyOnceWith(ENTRY.input, expect.any(Object)));
      expect(h.onQueue).not.toHaveBeenCalled();
    }
    expect(h.onRunShellCommand).not.toHaveBeenCalled();
    await waitFor(() => expect(input).toHaveValue(""));
    expect(h.drafts.has("draft-1")).toBe(false);
  });

  it("Alt+↑ 不覆盖输入框已有的草稿", async () => {
    const h = await setup(false);
    const input = screen.getByRole("textbox", { name: "任务输入" });
    await waitFor(() => expect(input).toBeEnabled());
    fireEvent.change(input, { target: { value: "正在撰写" } });
    expect(fireEvent.keyDown(input, { key: "ArrowUp", altKey: true })).toBe(true);
    expect(h.client.deleteQueuedSubmission).not.toHaveBeenCalled();
    expect(input).toHaveValue("正在撰写");
  });

  it("deleted:false 不产生恢复草稿，解锁输入并保持原消息状态", async () => {
    const h = await setup();
    const edit = screen.getByRole("button", { name: "将排队消息 1 移回输入框" });
    await waitFor(() => expect(edit).toBeEnabled());
    fireEvent.click(edit);
    await act(async () => h.resolveDelete({ deleted: false }));
    const input = screen.getByRole("textbox", { name: "任务输入" });
    await waitFor(() => expect(input).toBeEnabled());
    expect(input).toHaveValue("");
    expect(h.drafts.size).toBe(0);
    expect(screen.getByRole("alert")).toHaveTextContent("未撤回");
    expect(h.onQueue).not.toHaveBeenCalled();
  });
});
