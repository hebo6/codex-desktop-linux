import { useEffect, useId, useLayoutEffect, useRef } from "react";

import type { ThreadSummary } from "../app/useServerThreads";
import { useModalLayer } from "./modalStack";
import styles from "./ThreadDeleteDialog.module.css";

export interface ThreadDeleteDialogProps {
  readonly deleting: boolean;
  readonly error: string | null;
  readonly onCancel: () => void;
  readonly onConfirm: (threadId: string) => void;
  readonly serverName: string;
  readonly thread: ThreadSummary | null;
}

export function ThreadDeleteDialog({
  deleting,
  error,
  onCancel,
  onConfirm,
  serverName,
  thread,
}: ThreadDeleteDialogProps) {
  const titleId = useId();
  const descriptionId = useId();
  const dialogRef = useRef<HTMLElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const isTopmostModal = useModalLayer(thread !== null);

  useLayoutEffect(() => {
    if (thread === null) {
      return;
    }
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    cancelRef.current?.focus();
    return () => {
      if (previous?.isConnected) {
        previous.focus();
      }
    };
  }, [thread?.id]);

  useEffect(() => {
    if (thread === null) {
      return;
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!isTopmostModal()) {
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        if (!deleting) {
          onCancel();
        }
        return;
      }
      if (event.key !== "Tab") {
        return;
      }
      const buttons = [...(dialogRef.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? [])];
      const first = buttons[0];
      const last = buttons.at(-1);
      if (first === undefined || last === undefined) {
        event.preventDefault();
        dialogRef.current?.focus();
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [deleting, isTopmostModal, onCancel, thread]);

  if (thread === null) {
    return null;
  }

  const title = threadTitle(thread);
  const cancel = () => {
    if (!deleting) {
      onCancel();
    }
  };

  return (
    <div
      className={styles.backdrop}
      onClick={(event) => {
        if (event.target === event.currentTarget) {
          cancel();
        }
      }}
    >
      <section
        aria-busy={deleting || undefined}
        aria-describedby={descriptionId}
        aria-labelledby={titleId}
        aria-modal="true"
        className={styles.dialog}
        ref={dialogRef}
        role="dialog"
        tabIndex={-1}
      >
        <div className={styles.content}>
          <div aria-hidden="true" className={styles.icon}>!</div>
          <div>
            <h2 id={titleId}>删除会话？</h2>
            <div id={descriptionId}>
              <p>确定要永久删除“{title}”吗？</p>
              <p className={styles.detail}>服务器：{serverName}</p>
              <p className={styles.warning}>此操作不可恢复，会话将从服务端删除</p>
            </div>
          </div>
        </div>
        {error === null ? null : <div className={styles.error} role="alert">{error}</div>}
        <div className={styles.actions}>
          <button disabled={deleting} onClick={cancel} ref={cancelRef} type="button">取消</button>
          <button
            className={styles.deleteButton}
            disabled={deleting}
            onClick={() => onConfirm(thread.id)}
            type="button"
          >
            {deleting ? "正在删除" : "永久删除"}
          </button>
        </div>
      </section>
    </div>
  );
}

function threadTitle(thread: ThreadSummary): string {
  const name = thread.name?.trim();
  if (name !== undefined && name.length > 0) {
    return name;
  }
  const preview = thread.preview.trim().split(/\r?\n/u, 1)[0]?.trim();
  return preview === undefined || preview.length === 0 ? "未命名会话" : preview;
}
