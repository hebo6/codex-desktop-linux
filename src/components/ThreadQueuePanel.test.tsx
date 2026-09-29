import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ServerEventStore, type QueuedSubmission } from "../appServer/serverEventState";
import type { RequestHandle } from "../protocol/rpc/types";
import { ThreadQueuePanel } from "./ThreadQueuePanel";

const ENTRY: QueuedSubmission = { id: "queued-1", clientUserMessageId: "client-1", input: [{ type: "text", text: "下一项任务" }] };
const handle = <T,>(result: Promise<T>): RequestHandle<T> => ({ epoch: 1, id: 1, stage: "pending", result });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => { resolve = accept; });
  return { promise, resolve };
}
function setup(entries = [ENTRY]) {
  const store = new ServerEventStore();
  store.hydrateQueue("thread-1", 0, entries);
  const client = { deleteQueuedSubmission: vi.fn(() => handle(Promise.resolve({ deleted: true }))) };
  const onEdit = vi.fn(async (_entry: QueuedSubmission) => ({ ok: true, message: "已撤回到输入框" }));
  const props = { client, store, threadId: "thread-1", canEdit: true, onEdit };
  const view = render(<ThreadQueuePanel {...props} />);
  const open = () => fireEvent.click(screen.getByRole("button", { name: /^待发送队列/u }));
  return { ...props, ...view, open };
}

describe("ThreadQueuePanel", () => {
  it("等待删除成功后移除消息，并阻止重复点击", async () => {
    const h = setup();
    const result = deferred<{ deleted: boolean }>();
    h.client.deleteQueuedSubmission.mockReturnValue(handle(result.promise));
    h.open();
    fireEvent.click(screen.getByRole("button", { name: "撤销排队消息 1" }));
    expect(screen.getByText("1. 下一项任务")).toBeVisible();
    expect(screen.getByRole("button", { name: "撤销排队消息 1" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "编辑排队消息 1" })).toBeDisabled();
    expect(h.client.deleteQueuedSubmission).toHaveBeenCalledExactlyOnceWith("thread-1", "queued-1");
    await act(async () => result.resolve({ deleted: true }));
    expect(screen.getByRole("status")).toHaveTextContent("消息已撤销");
    expect(screen.queryByText("1. 下一项任务")).not.toBeInTheDocument();
    expect(h.onEdit).not.toHaveBeenCalled();
  });

  it("消息已被取走时不声称撤销成功，也不进入编辑", async () => {
    const h = setup();
    h.client.deleteQueuedSubmission.mockReturnValue(handle(Promise.resolve({ deleted: false })));
    h.open();
    fireEvent.click(screen.getByRole("button", { name: "撤销排队消息 1" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("未撤销");
    expect(screen.getByText("1. 下一项任务")).toBeVisible();
    expect(h.onEdit).not.toHaveBeenCalled();
  });

  it("网络失败保留队列内容并说明结果不确定", async () => {
    const h = setup();
    h.client.deleteQueuedSubmission.mockImplementation(() => handle(Promise.reject(new Error("connection closed"))));
    h.open();
    fireEvent.click(screen.getByRole("button", { name: "撤销排队消息 1" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("撤销结果不确定");
    expect(screen.getByText("1. 下一项任务")).toBeVisible();
  });

  it("编辑传递完整消息，并只在恢复操作成功后隐藏原条目", async () => {
    const input: QueuedSubmission["input"] = [
      { type: "text", text: `开头${"长".repeat(33_000)}`, text_elements: [{ byteRange: { start: 0, end: 6 } }] },
      { type: "image", fileId: "file-1", detail: "original" },
      { type: "audio", url: "data:audio/wav;base64,PRIVATE" },
      { type: "mention", name: "引用", path: "/workspace/ref" },
    ];
    const h = setup([{ ...ENTRY, input }]);
    const result = deferred<{ ok: boolean; message: string }>();
    h.onEdit.mockReturnValue(result.promise);
    h.open();
    fireEvent.click(screen.getByRole("button", { name: "编辑排队消息 1" }));
    expect(h.onEdit).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ input }));
    expect(h.client.deleteQueuedSubmission).not.toHaveBeenCalled();
    expect(document.body.textContent).not.toContain("PRIVATE");
    await act(async () => result.resolve({ ok: true, message: "已撤回到输入框" }));
    expect(screen.getByRole("status")).toHaveTextContent("已撤回到输入框");
    expect(screen.queryByRole("button", { name: "编辑排队消息 1" })).not.toBeInTheDocument();
  });

  it("已有草稿时只禁用编辑，撤销仍可用", () => {
    const h = setup();
    h.rerender(<ThreadQueuePanel {...h} canEdit={false} />);
    h.open();
    expect(screen.getByRole("button", { name: "编辑排队消息 1" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "撤销排队消息 1" })).toBeEnabled();
  });

  it("通知已使队列失效但 UI 尚未刷新时，不发送删除请求", () => {
    const h = setup();
    h.open();
    act(() => h.store.consume({ method: "thread/queue/changed", params: { threadId: "thread-1" } }));
    fireEvent.click(screen.getByRole("button", { name: "撤销排队消息 1" }));
    expect(h.client.deleteQueuedSubmission).not.toHaveBeenCalled();
  });

  it("断线禁用操作，旧连接的迟到结果不会变为成功提示", async () => {
    const h = setup();
    const result = deferred<{ deleted: boolean }>();
    h.client.deleteQueuedSubmission.mockReturnValue(handle(result.promise));
    h.open();
    fireEvent.click(screen.getByRole("button", { name: "撤销排队消息 1" }));
    h.rerender(<ThreadQueuePanel {...h} client={null} />);
    await act(async () => result.resolve({ deleted: true }));
    expect(screen.getByRole("alert")).toHaveTextContent("操作结果待确认");
    expect(screen.getByText("1. 下一项任务")).toBeVisible();
    expect(screen.getByRole("button", { name: "撤销排队消息 1" })).toBeDisabled();
  });

  it("仅附件消息展示输入类型，不展开媒体载荷", () => {
    const h = setup([{ ...ENTRY, input: [
      { type: "image", url: "data:image/png;base64,PRIVATE" },
      { type: "localAudio", path: "/tmp/voice.wav" },
      { type: "skill", name: "review", path: "/workspace/review" },
    ] }]);
    h.open();
    expect(screen.getByText("1. 图片附件、音频附件、技能 review")).toBeVisible();
    expect(document.body.textContent).not.toContain("PRIVATE");
  });

  it("空队列不产生面板", () => {
    setup([]);
    expect(screen.queryByRole("button", { name: /^待发送队列/u })).not.toBeInTheDocument();
  });
});
