import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { QueueClient } from "../appServer";
import type { QueuedSubmission } from "../appServer/serverEventState";
import { restoreQueuedDraft } from "../content/queuedDraft";
import type { ThreadQueueDeleteResponse } from "../protocol/generated";
import { RpcRemoteError } from "../protocol/rpc/errors";
import type { RequestHandle } from "../protocol/rpc";
import type { DraftStore } from "../transport/drafts";
import { useQueueMessageEditing, type UseQueueMessageEditingOptions } from "./useQueueMessageEditing";

const ENTRY: QueuedSubmission = {
  id: "queued-1",
  clientUserMessageId: "message-1",
  input: [
    { type: "text", text: "原文\n".repeat(200), text_elements: [{ byteRange: { start: 0, end: 6 } }] },
    { type: "image", fileId: "file-1", detail: "original" },
    { type: "mention", name: "file", path: "/workspace/file.ts", extension: true },
  ],
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function setup() {
  const deletion = deferred<ThreadQueueDeleteResponse>();
  const client: QueueClient = {
    deleteQueuedSubmission: vi.fn(() => ({
      epoch: 1,
      id: "request-1",
      stage: "pending",
      result: deletion.promise,
    } satisfies RequestHandle<ThreadQueueDeleteResponse>)),
  };
  const draftStore: DraftStore = {
    listKeys: vi.fn(async () => []),
    load: vi.fn(async () => null),
    save: vi.fn(async () => undefined),
    delete: vi.fn(async () => undefined),
    transition: vi.fn(async () => undefined),
  };
  const options: UseQueueMessageEditingOptions = {
    client,
    draftKey: "server-1:thread-1",
    threadId: "thread-1",
    draftStore,
  };
  const hook = renderHook((props: UseQueueMessageEditingOptions) => useQueueMessageEditing(props), {
    initialProps: options,
  });
  return { ...hook, options, client, draftStore, deletion };
}

describe("useQueueMessageEditing", () => {
  it("输入框可恢复且服务端确认删除后，完整保存并交付原始输入", async () => {
    const { result, client, draftStore, deletion } = setup();
    expect(result.current.available).toBe(false);
    act(() => result.current.onAvailabilityChange(true));
    expect(result.current.available).toBe(true);

    let operation!: ReturnType<typeof result.current.edit>;
    act(() => { operation = result.current.edit(ENTRY); });
    expect(result.current.pending).toBe(true);
    expect(result.current.available).toBe(false);
    expect(draftStore.save).not.toHaveBeenCalled();
    expect(result.current.request).toBeNull();
    expect(client.deleteQueuedSubmission).toHaveBeenCalledWith("thread-1", ENTRY.id);

    await act(async () => {
      deletion.resolve({ deleted: true });
      expect(await operation).toEqual({ ok: true, message: "消息已撤回到输入框，修改后可重新排队" });
    });
    expect(draftStore.save).toHaveBeenCalledWith("server-1:thread-1", restoreQueuedDraft(ENTRY.input));
    expect(result.current.request?.input).toBe(ENTRY.input);
    expect(result.current.pending).toBe(false);
    expect(result.current.available).toBe(false);
    act(() => result.current.onApplied("unrelated"));
    expect(result.current.request).not.toBeNull();
    act(() => result.current.onApplied(result.current.request!.id));
    expect(result.current.request).toBeNull();
    expect(result.current.available).toBe(false);
    await expect(result.current.edit(ENTRY)).resolves.toMatchObject({ ok: false });
    expect(client.deleteQueuedSubmission).toHaveBeenCalledTimes(1);
  });

  it("输入框已有内容、客户端缺失或缺少会话时拒绝撤回", async () => {
    const { result, rerender, options, client } = setup();
    await expect(result.current.edit(ENTRY)).resolves.toMatchObject({ ok: false });
    for (const props of [
      { ...options, client: null },
      { ...options, draftKey: null },
      { ...options, threadId: null },
    ]) {
      rerender(props);
      act(() => result.current.onAvailabilityChange(true));
      expect(result.current.available).toBe(false);
      await expect(result.current.edit(ENTRY)).resolves.toMatchObject({ ok: false });
    }
    expect(client.deleteQueuedSubmission).not.toHaveBeenCalled();
  });

  it("同步锁拦截同一次事件中的双击，保存期间也保持锁定", async () => {
    const { result, client, draftStore, deletion } = setup();
    const persistence = deferred<void>();
    vi.mocked(draftStore.save).mockReturnValue(persistence.promise);
    act(() => result.current.onAvailabilityChange(true));
    let first!: ReturnType<typeof result.current.edit>;
    let second!: ReturnType<typeof result.current.edit>;
    act(() => {
      first = result.current.edit(ENTRY);
      second = result.current.edit(ENTRY);
    });
    await expect(second).resolves.toMatchObject({ ok: false });
    expect(client.deleteQueuedSubmission).toHaveBeenCalledTimes(1);
    await act(async () => { deletion.resolve({ deleted: true }); });
    expect(result.current.pending).toBe(true);
    await expect(result.current.edit(ENTRY)).resolves.toMatchObject({ ok: false });
    await act(async () => {
      persistence.resolve();
      await first;
    });
    expect(result.current.pending).toBe(false);
  });

  it.each([
    { kind: "false", error: null, message: "未撤回：消息已不在队列中" },
    { kind: "remote", error: new RpcRemoteError(-32602, "missing"), message: "服务端未接受撤回" },
    { kind: "uncertain", error: new Error("connection closed"), message: "撤回结果不确定" },
  ])("$kind 不恢复草稿或声称撤回成功", async ({ error, message }) => {
    const { result, deletion, draftStore } = setup();
    act(() => result.current.onAvailabilityChange(true));
    let operation!: ReturnType<typeof result.current.edit>;
    act(() => { operation = result.current.edit(ENTRY); });
    await act(async () => {
      if (error === null) deletion.resolve({ deleted: false });
      else deletion.reject(error);
      const outcome = await operation;
      expect(outcome.ok).toBe(false);
      expect(outcome.message).toContain(message);
    });
    expect(draftStore.save).not.toHaveBeenCalled();
    expect(result.current.request).toBeNull();
    expect(result.current.pending).toBe(false);
  });

  it("切换会话后只保存原会话，不接收旧来源回调或回填新会话", async () => {
    const { result, rerender, options, deletion, draftStore } = setup();
    const oldAvailability = result.current.onAvailabilityChange;
    const oldEdit = result.current.edit;
    act(() => oldAvailability(true));
    let operation!: ReturnType<typeof result.current.edit>;
    act(() => { operation = result.current.edit(ENTRY); });
    rerender({ ...options, draftKey: "server-1:thread-2", threadId: "thread-2" });
    act(() => oldAvailability(true));
    expect(result.current.available).toBe(false);
    await act(async () => {
      deletion.resolve({ deleted: true });
      expect(await operation).toEqual({ ok: true, message: "消息已撤回并保存到原会话草稿" });
    });
    expect(draftStore.save).toHaveBeenCalledWith(options.draftKey, restoreQueuedDraft(ENTRY.input));
    expect(result.current.request).toBeNull();
    await expect(oldEdit(ENTRY)).resolves.toMatchObject({ ok: false });
    rerender(options);
    expect(result.current.request).toBeNull();
  });

  it("撤回期间连接替换但仍为原草稿时交付恢复内容", async () => {
    const { result, rerender, options, deletion, draftStore } = setup();
    act(() => result.current.onAvailabilityChange(true));
    let operation!: ReturnType<typeof result.current.edit>;
    act(() => { operation = result.current.edit(ENTRY); });
    const reconnectedClient: QueueClient = { deleteQueuedSubmission: vi.fn() };
    rerender({ ...options, client: reconnectedClient });
    await act(async () => {
      deletion.resolve({ deleted: true });
      await operation;
    });
    expect(draftStore.save).toHaveBeenCalledWith(options.draftKey, restoreQueuedDraft(ENTRY.input));
    expect(result.current.request?.input).toBe(ENTRY.input);
    expect(reconnectedClient.deleteQueuedSubmission).not.toHaveBeenCalled();
  });

  it("已保存但尚未应用的恢复请求在同一草稿重连后继续交付", async () => {
    const { result, rerender, options, deletion } = setup();
    act(() => result.current.onAvailabilityChange(true));
    let operation!: ReturnType<typeof result.current.edit>;
    act(() => { operation = result.current.edit(ENTRY); });
    await act(async () => {
      deletion.resolve({ deleted: true });
      await operation;
    });
    const recoveryId = result.current.request!.id;
    rerender({ ...options, client: null });
    const reconnectedClient: QueueClient = { deleteQueuedSubmission: vi.fn() };
    rerender({ ...options, client: reconnectedClient });
    act(() => result.current.onAvailabilityChange(true));
    expect(result.current.request).toEqual({ id: recoveryId, input: ENTRY.input });
    expect(result.current.available).toBe(false);
    await expect(result.current.edit(ENTRY)).resolves.toMatchObject({ ok: false });
    expect(reconnectedClient.deleteQueuedSubmission).not.toHaveBeenCalled();
  });

  it("纯媒体草稿保存失败后仍保留完整恢复请求，阻止再次撤回覆盖", async () => {
    const { result, deletion, draftStore, client } = setup();
    const entry: QueuedSubmission = {
      ...ENTRY,
      input: [{ type: "localAudio", path: "/workspace/audio.wav" }, { type: "image", fileId: "file-1" }],
    };
    vi.mocked(draftStore.save).mockRejectedValue(new Error("disk full"));
    act(() => result.current.onAvailabilityChange(true));
    let operation!: ReturnType<typeof result.current.edit>;
    act(() => { operation = result.current.edit(entry); });
    await act(async () => {
      deletion.resolve({ deleted: true });
      const outcome = await operation;
      expect(outcome.ok).toBe(true);
      expect(outcome.message).toContain("草稿保存失败");
    });
    expect(result.current.request?.input).toBe(entry.input);
    await expect(result.current.edit(ENTRY)).resolves.toMatchObject({ ok: false });
    expect(client.deleteQueuedSubmission).toHaveBeenCalledTimes(1);
  });

  it("离开原会话时保存失败，返回后仍可交付完整内容", async () => {
    const { result, rerender, options, deletion, draftStore } = setup();
    vi.mocked(draftStore.save).mockRejectedValue(new Error("disk full"));
    act(() => result.current.onAvailabilityChange(true));
    let operation!: ReturnType<typeof result.current.edit>;
    act(() => { operation = result.current.edit(ENTRY); });
    rerender({ ...options, draftKey: "server-1:thread-2", threadId: "thread-2" });
    await act(async () => {
      deletion.resolve({ deleted: true });
      await operation;
    });
    expect(result.current.request).toBeNull();
    rerender(options);
    expect(result.current.request?.input).toBe(ENTRY.input);
    expect(result.current.available).toBe(false);
  });

  it("保存失败后重连同一草稿仍可恢复，并禁止再次撤回覆盖", async () => {
    const { result, rerender, options, deletion, draftStore } = setup();
    vi.mocked(draftStore.save).mockRejectedValue(new Error("disk full"));
    act(() => result.current.onAvailabilityChange(true));
    let operation!: ReturnType<typeof result.current.edit>;
    act(() => { operation = result.current.edit(ENTRY); });
    await act(async () => {
      deletion.resolve({ deleted: true });
      await operation;
    });
    const recoveryId = result.current.request!.id;
    rerender({ ...options, client: null });
    const reconnectedClient: QueueClient = { deleteQueuedSubmission: vi.fn() };
    rerender({ ...options, client: reconnectedClient });
    act(() => result.current.onAvailabilityChange(true));

    expect(result.current.request).toEqual({ id: recoveryId, input: ENTRY.input });
    expect(result.current.available).toBe(false);
    await expect(result.current.edit(ENTRY)).resolves.toMatchObject({ ok: false });
    expect(reconnectedClient.deleteQueuedSubmission).not.toHaveBeenCalled();

    act(() => result.current.onApplied(recoveryId));
    expect(result.current.request).toBeNull();
    expect(result.current.available).toBe(false);
    await expect(result.current.edit(ENTRY)).resolves.toMatchObject({ ok: false });
    expect(reconnectedClient.deleteQueuedSubmission).not.toHaveBeenCalled();
  });

  it("已保存的待应用恢复请求在切换后交给草稿加载处理", async () => {
    const { result, rerender, options, deletion } = setup();
    act(() => result.current.onAvailabilityChange(true));
    let operation!: ReturnType<typeof result.current.edit>;
    act(() => { operation = result.current.edit(ENTRY); });
    await act(async () => {
      deletion.resolve({ deleted: true });
      await operation;
    });
    expect(result.current.request).not.toBeNull();
    rerender({ ...options, draftKey: "server-1:thread-2", threadId: "thread-2" });
    rerender(options);
    expect(result.current.request).toBeNull();
  });
});
