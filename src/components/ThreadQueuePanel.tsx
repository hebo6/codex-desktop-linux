import { useCallback, useEffect, useRef, useState } from "react";

import { useServerEvents } from "../app/useServerEvents";
import type { QueueClient } from "../appServer/conversationClient";
import type { QueueInputPreview, QueuedSubmission, ServerEventStore } from "../appServer/serverEventState";
import { RpcRemoteError } from "../protocol/rpc/errors";
import { ComposerAccessoryDisclosure } from "./ComposerAccessoryPanel";
import styles from "./ThreadQueuePanel.module.css";

export function ThreadQueuePanel({ client, store, threadId, canEdit, onEdit }: {
  readonly client: QueueClient | null;
  readonly store: ServerEventStore | null;
  readonly threadId: string;
  readonly canEdit: boolean;
  readonly onEdit: (entry: QueuedSubmission) => Promise<{ readonly ok: boolean; readonly message: string }>;
}) {
  const snapshot = useServerEvents(store);
  const queue = snapshot?.queuesByThread[threadId];
  const [expanded, setExpanded] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<{ readonly error: boolean; readonly text: string } | null>(null);
  const [withdrawn, setWithdrawn] = useState<ReadonlySet<string>>(new Set());
  const operationRef = useRef<symbol | null>(null);
  const sourceRef = useRef({ client, store, threadId });
  sourceRef.current = { client, store, threadId };

  useEffect(() => () => { operationRef.current = null; }, []);
  useEffect(() => {
    if (operationRef.current !== null) {
      operationRef.current = null;
      setPending(null);
      setFeedback({ error: true, text: "连接已变化，操作结果待确认，请等待队列重新同步" });
    }
  }, [client, store, threadId]);

  const entries = queue?.entries.filter((entry) => !withdrawn.has(entry.id)) ?? [];
  const ready = client !== null && snapshot?.connected === true && queue?.status === "ready";

  const withdraw = useCallback(async (entryId: string, edit: boolean) => {
    if (!ready || client === null || operationRef.current !== null || (edit && !canEdit)) return;
    // Notifications reach the store before its batched UI subscription updates.
    const latest = store?.getSnapshot();
    const latestQueue = latest?.queuesByThread[threadId];
    const entry = latestQueue?.entries.find((item) => item.id === entryId);
    if (!latest?.connected || latestQueue?.status !== "ready") return;
    if (entry === undefined) {
      setFeedback({ error: true, text: "消息已不在队列中，可能已开始执行或被撤销" });
      return;
    }
    const operation = Symbol("withdraw-queue-message");
    operationRef.current = operation;
    setPending(entryId);
    setFeedback(null);
    const isCurrent = () => operationRef.current === operation
      && sourceRef.current.client === client && sourceRef.current.store === store
      && sourceRef.current.threadId === threadId;
    try {
      const result = edit
        ? await onEdit({ id: entry.id, clientUserMessageId: entry.clientUserMessageId, input: entry.input })
        : await client.deleteQueuedSubmission(threadId, entry.id).result.then(({ deleted }) => ({
          ok: deleted,
          message: deleted ? "消息已撤销" : "未撤销：消息已不在队列中，可能已开始执行或被其他客户端撤销",
        }));
      if (!isCurrent()) return;
      if (result.ok) setWithdrawn((current) => new Set([...current, entry.id]));
      setFeedback({ error: !result.ok, text: result.message });
    } catch (error) {
      if (!isCurrent()) return;
      setFeedback({ error: true, text: error instanceof RpcRemoteError
        ? "服务端未接受撤销，请确认队列状态后重试"
        : "撤销结果不确定，请确认队列状态后再操作" });
    } finally {
      if (isCurrent()) {
        operationRef.current = null;
        setPending(null);
      }
    }
  }, [canEdit, client, onEdit, ready, store, threadId]);

  useEffect(() => {
    const handleShortcut = (event: KeyboardEvent) => {
      if (
        event.key !== "ArrowUp" || !event.altKey || event.ctrlKey || event.shiftKey || event.metaKey
        || event.defaultPrevented || event.repeat || event.isComposing
        || !ready || !canEdit || operationRef.current !== null
        || document.querySelector('[aria-modal="true"], [role="dialog"], [role="menu"], [role="listbox"]') !== null
      ) return;
      if (event.target instanceof HTMLElement && (
        event.target.matches('input, select, textarea:not([data-composer-input])')
        || event.target.isContentEditable
      )) return;

      const latest = store?.getSnapshot();
      const latestQueue = latest?.queuesByThread[threadId];
      if (!latest?.connected || latestQueue?.status !== "ready") return;
      const entry = latestQueue.entries.findLast((item) => !withdrawn.has(item.id));
      if (entry === undefined) return;

      event.preventDefault();
      void withdraw(entry.id, true);
    };
    window.addEventListener("keydown", handleShortcut);
    return () => window.removeEventListener("keydown", handleShortcut);
  }, [canEdit, ready, store, threadId, withdraw, withdrawn]);

  if (entries.length === 0 && feedback === null
    && (queue === undefined || queue.status === "ready")) return null;

  return <ComposerAccessoryDisclosure
    expanded={expanded}
    icon={<svg aria-hidden="true" viewBox="0 0 24 24"><path d="M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01" /></svg>}
    label="待发送队列"
    onExpandedChange={setExpanded}
    summary={<>
      {`待发送队列 · ${entries.length} 条`}
      {!expanded && feedback !== null ? <span role={feedback.error ? "alert" : "status"} title={feedback.text}> · {feedback.text}</span> : null}
    </>}
  >
    <div className={styles.content}>
      {queue?.status === "pending" ? <p className={styles.hint}>正在刷新队列</p> : null}
      {queue?.status === "unknown" ? <p className={styles.hint}>连接已断开，队列状态待同步</p> : null}
      {queue?.status === "error" ? <p role="alert">{queue.error}</p> : null}
      {feedback === null ? null : <div className={styles.feedback}>
        <p role={feedback.error ? "alert" : "status"}>{feedback.text}</p>
        <button aria-label="关闭队列提示" onClick={() => setFeedback(null)} type="button">×</button>
      </div>}
      <ol className={styles.list} aria-label="待发送消息">
        {entries.map((entry, index) => <li key={entry.id}>
          <span className={styles.preview} title={entry.text}>{index + 1}. {entry.text || entry.inputs.map(inputLabel).join("、")}</span>
          <button
            aria-label={`编辑排队消息 ${index + 1}`}
            aria-keyshortcuts={index === entries.length - 1 ? "Alt+ArrowUp" : undefined}
            disabled={!ready || !canEdit || pending !== null}
            onClick={() => void withdraw(entry.id, true)}
            title={canEdit
              ? `撤回到输入框，修改后重新排队${index === entries.length - 1 ? "（Alt+↑）" : ""}`
              : "请先处理输入框中的草稿，并等待当前操作完成"}
            type="button"
          >编辑</button>
          <button aria-label={`撤销排队消息 ${index + 1}`} disabled={!ready || pending !== null} onClick={() => void withdraw(entry.id, false)} type="button">{pending === entry.id ? "处理中…" : "撤销"}</button>
        </li>)}
      </ol>
      {entries.length > 0 ? <p className={styles.hint}>编辑会先撤回到输入框，重新排队时进入队尾</p> : null}
    </div>
  </ComposerAccessoryDisclosure>;
}

function inputLabel(input: QueueInputPreview): string {
  switch (input.type) {
    case "text": return "文字";
    case "image": case "localImage": return "图片附件";
    case "audio": case "localAudio": return "音频附件";
    case "skill": return `技能 ${input.name}`;
    case "mention": return `引用 ${input.name}`;
  }
}
