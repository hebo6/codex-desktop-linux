import { useCallback, useEffect, useRef, useState } from "react";

import type { QueueClient } from "../appServer";
import type { QueuedSubmission } from "../appServer/serverEventState";
import { restoreQueuedDraft } from "../content/queuedDraft";
import type { UserInput } from "../protocol/generated";
import { RpcRemoteError } from "../protocol/rpc/errors";
import type { DraftStore } from "../transport/drafts";

interface Source {
  readonly client: QueueClient | null;
  readonly draftKey: string | null;
  readonly threadId: string | null;
}

interface QueueEditRequest {
  readonly id: string;
  readonly input: UserInput[];
}

interface Recovery {
  readonly source: Source;
  readonly request: QueueEditRequest;
  readonly persisted: boolean;
}

export interface UseQueueMessageEditingOptions extends Source {
  readonly draftStore: DraftStore;
}

export function useQueueMessageEditing({
  client,
  draftKey,
  threadId,
  draftStore,
}: UseQueueMessageEditingOptions) {
  const source = { client, draftKey, threadId };
  const sourceRef = useRef<Source>(source);
  sourceRef.current = source;
  const pendingRef = useRef(false);
  const [pending, setPending] = useState(false);
  const availabilityRef = useRef<{ source: Source; available: boolean } | null>(null);
  const [availability, setAvailability] = useState(availabilityRef.current);
  const recoveriesRef = useRef<readonly Recovery[]>([]);
  const [recoveries, setRecoveries] = useState(recoveriesRef.current);

  const onAvailabilityChange = useCallback((available: boolean) => {
    const callbackSource = { client, draftKey, threadId };
    if (!sameSource(callbackSource, sourceRef.current)) return;
    const next = { source: callbackSource, available };
    availabilityRef.current = next;
    setAvailability(next);
  }, [client, draftKey, threadId]);

  const onApplied = useCallback((id: string) => {
    const applied = recoveriesRef.current.find((recovery) => recovery.request.id === id);
    if (applied === undefined) return;
    const next = recoveriesRef.current.filter((recovery) => recovery.request.id !== id);
    recoveriesRef.current = next;
    setRecoveries(next);
    if (sameDraft(applied.source, sourceRef.current)) {
      const unavailable = { source: sourceRef.current, available: false };
      availabilityRef.current = unavailable;
      setAvailability(unavailable);
    }
  }, []);

  useEffect(() => {
    // Saved drafts load normally after switching; only unsaved recoveries need to stay in memory.
    const next = recoveriesRef.current.filter((recovery) =>
      !recovery.persisted || sameDraft(recovery.source, sourceRef.current)
    );
    if (next.length !== recoveriesRef.current.length) {
      recoveriesRef.current = next;
      setRecoveries(next);
    }
  }, [client, draftKey, threadId]);

  const edit = useCallback(async (entry: QueuedSubmission) => {
    const origin = { client, draftKey, threadId };
    const readiness = availabilityRef.current;
    if (pendingRef.current) return { ok: false, message: "正在撤回消息，请稍候" };
    if (client === null || draftKey === null || threadId === null
      || !sameSource(origin, sourceRef.current)) {
      return { ok: false, message: "会话已变化，请在原会话中重试" };
    }
    if (readiness === null || !sameSource(readiness.source, origin) || !readiness.available
      || recoveriesRef.current.some((recovery) => sameDraft(recovery.source, origin))) {
      return { ok: false, message: "请先发送或清空输入框，再编辑队列消息" };
    }

    pendingRef.current = true;
    setPending(true);
    try {
      let deleted: boolean;
      try {
        ({ deleted } = await client.deleteQueuedSubmission(threadId, entry.id).result);
      } catch (error) {
        return {
          ok: false,
          message: error instanceof RpcRemoteError
            ? "服务端未接受撤回，请确认队列状态后重试"
            : "撤回结果不确定，请确认队列状态后再操作",
        };
      }
      if (!deleted) {
        return { ok: false, message: "未撤回：消息已不在队列中，可能已开始执行或被其他客户端撤回" };
      }

      const restored = restoreQueuedDraft(entry.input);
      let persisted = true;
      try {
        await draftStore.save(draftKey, restored);
      } catch {
        persisted = false;
      }
      const current = sameDraft(origin, sourceRef.current);
      if (current || !persisted) {
        const next = [...recoveriesRef.current, {
          source: origin,
          request: { id: crypto.randomUUID(), input: entry.input },
          persisted,
        }];
        recoveriesRef.current = next;
        setRecoveries(next);
      }
      if (!persisted) {
        return { ok: true, message: "消息已撤回，但草稿保存失败；完整内容已保留，请回到原会话继续编辑" };
      }
      return {
        ok: true,
        message: current ? "消息已撤回到输入框，修改后可重新排队" : "消息已撤回并保存到原会话草稿",
      };
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
  }, [client, draftKey, draftStore, threadId]);

  const request = recoveries.find((recovery) => sameDraft(recovery.source, source))?.request ?? null;
  return {
    available: client !== null && draftKey !== null && threadId !== null && !pending
      && request === null && availability !== null
      && sameSource(availability.source, source) && availability.available,
    pending,
    request,
    onAvailabilityChange,
    onApplied,
    edit,
  };
}

function sameSource(left: Source, right: Source): boolean {
  return left.client === right.client && sameDraft(left, right);
}

function sameDraft(left: Source, right: Source): boolean {
  return left.draftKey === right.draftKey && left.threadId === right.threadId;
}
