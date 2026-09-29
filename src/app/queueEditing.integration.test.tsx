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
    { type: "text", text: "!这仍是一条消息", text_elements: [{ byteRange: { start: 0, end: 1 } }] },
    { type: "image", fileId: "server-image", detail: "original" },
    { type: "mention", name: "说明", path: "/workspace/readme.md" },
  ],
};

function setup() {
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
      activeTurn={false}
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
  const view = render(<Harness />);
  fireEvent.click(screen.getByRole("button", { name: /^待发送队列/u }));
  return { ...view, store, client, drafts, draftStore, onQueue, onSend, onRunShellCommand, resolveDelete };
}

describe("队列撤回与输入框协作", () => {
  it("收到删除确认后恢复草稿并聚焦，空闲时提交也重新排队且保留附件", async () => {
    const h = setup();
    const edit = screen.getByRole("button", { name: "编辑排队消息 1" });
    await waitFor(() => expect(edit).toBeEnabled());
    fireEvent.click(edit);
    const input = screen.getByRole("textbox", { name: "任务输入" });
    expect(input).toBeDisabled();
    expect(input).toHaveValue("");
    expect(h.drafts.size).toBe(0);
    // A queue-change notification can arrive before the delete response.
    act(() => {
      h.store.consume({ method: "thread/queue/changed", params: { threadId: "thread-1" } });
      h.store.hydrateQueue("thread-1", 1, []);
    });
    await act(async () => h.resolveDelete({ deleted: true }));
    await waitFor(() => expect(input).toHaveValue("!这仍是一条消息"));
    await waitFor(() => expect(input).toHaveFocus());
    expect(h.drafts.get("draft-1")?.restoredInput).toEqual(ENTRY.input);
    expect(screen.getByRole("button", { name: "重新排队" })).toBeEnabled();
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(h.onQueue).toHaveBeenCalledExactlyOnceWith(ENTRY.input));
    expect(h.onSend).not.toHaveBeenCalled();
    expect(h.onRunShellCommand).not.toHaveBeenCalled();
    await waitFor(() => expect(input).toHaveValue(""));
    expect(h.drafts.has("draft-1")).toBe(false);
  });

  it("deleted:false 不产生恢复草稿，解锁输入并保持原消息状态", async () => {
    const h = setup();
    const edit = screen.getByRole("button", { name: "编辑排队消息 1" });
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
