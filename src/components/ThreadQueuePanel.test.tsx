import { act, createEvent, fireEvent, render, screen } from "@testing-library/react";
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
  it("Alt+↑ 在队列收起时编辑最新队尾，等待结果期间不重复撤回", async () => {
    const latest = { ...ENTRY, id: "queued-2", clientUserMessageId: "client-2" };
    const h = setup();
    const result = deferred<{ ok: boolean; message: string }>();
    h.onEdit.mockReturnValue(result.promise);
    // The store updates before the batched React subscription renders.
    act(() => { h.store.hydrateQueue("thread-1", 0, [ENTRY, latest]); });

    expect(fireEvent.keyDown(window, { key: "ArrowUp", altKey: true })).toBe(false);
    fireEvent.keyDown(window, { key: "ArrowUp", altKey: true });
    expect(h.onEdit).toHaveBeenCalledExactlyOnceWith(latest);
    expect(h.client.deleteQueuedSubmission).not.toHaveBeenCalled();
    await act(async () => result.resolve({ ok: true, message: "已撤回到输入框" }));
    expect(screen.getByRole("status")).toHaveTextContent("已撤回到输入框");

    // A successful withdrawal must not be selected again before the next notification.
    fireEvent.keyDown(window, { key: "ArrowUp", altKey: true });
    expect(h.onEdit).toHaveBeenLastCalledWith(ENTRY);
    await act(async () => {});
  });

  it("快捷键撤回失败时在收起的摘要中显示原因并保留消息", async () => {
    const h = setup();
    h.onEdit.mockResolvedValue({ ok: false, message: "未撤回：消息已开始执行" });
    fireEvent.keyDown(window, { key: "ArrowUp", altKey: true });
    expect(await screen.findByRole("alert")).toHaveTextContent("未撤回：消息已开始执行");
    h.open();
    expect(screen.getByText("1. 下一项任务")).toBeVisible();
  });

  it.each([
    { key: "ArrowUp" },
    { key: "ArrowLeft", shiftKey: true },
    { key: "ArrowUp", altKey: true, ctrlKey: true },
    { key: "ArrowUp", altKey: true, shiftKey: true },
    { key: "ArrowUp", altKey: true, metaKey: true },
    { key: "ArrowUp", altKey: true, repeat: true },
    { key: "ArrowUp", altKey: true, isComposing: true },
  ])("不响应不匹配、长按或合成按键 %j", (key) => {
    const h = setup();
    expect(fireEvent.keyDown(window, key)).toBe(true);
    expect(h.onEdit).not.toHaveBeenCalled();
  });

  it("忽略已处理的按键", () => {
    const h = setup();
    const event = createEvent.keyDown(window, { key: "ArrowUp", altKey: true });
    event.preventDefault();
    fireEvent(window, event);
    expect(h.onEdit).not.toHaveBeenCalled();
  });

  it.each(["dialog", "menu", "listbox"])("%s 打开时不编辑队列", (role) => {
    const h = setup();
    render(<div role={role} />);
    expect(fireEvent.keyDown(window, { key: "ArrowUp", altKey: true })).toBe(true);
    expect(h.onEdit).not.toHaveBeenCalled();
  });

  it("其他输入控件使用 Alt+↑ 时不编辑队列", () => {
    const h = setup();
    render(<><input aria-label="搜索" /><textarea aria-label="其他草稿" /><select aria-label="选项" /></>);
    for (const name of ["搜索", "其他草稿", "选项"]) {
      expect(fireEvent.keyDown(screen.getByLabelText(name), { key: "ArrowUp", altKey: true })).toBe(true);
    }
    expect(h.onEdit).not.toHaveBeenCalled();
  });

  it("队列状态失效但界面尚未刷新时，快捷键不编辑消息", () => {
    const h = setup();
    act(() => h.store.consume({ method: "thread/queue/changed", params: { threadId: "thread-1" } }));
    expect(fireEvent.keyDown(window, { key: "ArrowUp", altKey: true })).toBe(true);
    expect(h.onEdit).not.toHaveBeenCalled();
  });

  it("断开连接后立即停止响应快捷键", () => {
    const h = setup();
    act(() => h.store.disconnect());
    expect(fireEvent.keyDown(window, { key: "ArrowUp", altKey: true })).toBe(true);
    expect(h.onEdit).not.toHaveBeenCalled();
  });

  it("只为队尾编辑按钮标注快捷键", () => {
    const h = setup([ENTRY, { ...ENTRY, id: "queued-2" }]);
    h.open();
    expect(screen.getByRole("button", { name: "编辑排队消息 1" })).not.toHaveAttribute("aria-keyshortcuts");
    expect(screen.getByRole("button", { name: "编辑排队消息 2" })).toHaveAttribute("aria-keyshortcuts", "Alt+ArrowUp");
  });

  it("等待删除成功后移除最后一条消息并隐藏面板，期间阻止重复点击", async () => {
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
    expect(screen.queryByRole("region", { name: "待发送队列" })).not.toBeInTheDocument();
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

  it("编辑传递完整消息，并只在恢复操作成功后隐藏空队列面板", async () => {
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
    expect(screen.queryByRole("region", { name: "待发送队列" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "编辑排队消息 1" })).not.toBeInTheDocument();
  });

  it("已有草稿时只禁用编辑，撤销仍可用", () => {
    const h = setup();
    h.rerender(<ThreadQueuePanel {...h} canEdit={false} />);
    h.open();
    expect(screen.getByRole("button", { name: "编辑排队消息 1" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "撤销排队消息 1" })).toBeEnabled();
    expect(fireEvent.keyDown(window, { key: "ArrowUp", altKey: true })).toBe(true);
    expect(h.onEdit).not.toHaveBeenCalled();
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
    const h = setup([]);
    expect(screen.queryByRole("button", { name: /^待发送队列/u })).not.toBeInTheDocument();
    expect(fireEvent.keyDown(window, { key: "ArrowUp", altKey: true })).toBe(true);
    expect(h.onEdit).not.toHaveBeenCalled();
  });
});
