import { useEffect, useId, useLayoutEffect, useRef } from "react";

import { useModalLayer } from "./modalStack";
import styles from "./ThreadDeleteDialog.module.css";

export function ThreadForkDialog({
  error,
  forking,
  onCancel,
  onConfirm,
  turnId,
}: {
  readonly error: string | null;
  readonly forking: boolean;
  readonly onCancel: () => void;
  readonly onConfirm: (turnId: string) => void;
  readonly turnId: string | null;
}) {
  const titleId = useId();
  const descriptionId = useId();
  const dialogRef = useRef<HTMLElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const isTopmostModal = useModalLayer(turnId !== null);

  useLayoutEffect(() => {
    if (turnId === null) {
      return;
    }
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    cancelRef.current?.focus();
    return () => {
      if (previous?.isConnected) {
        previous.focus();
      }
    };
  }, [turnId]);

  useEffect(() => {
    if (turnId === null) {
      return;
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!isTopmostModal()) {
        return;
      }
      if (event.key === "Escape" && !forking) {
        event.preventDefault();
        onCancel();
      }
      if (event.key !== "Tab") {
        return;
      }
      const buttons = [...(dialogRef.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? [])];
      const first = buttons[0];
      const last = buttons.at(-1);
      if (first === undefined || last === undefined) {
        event.preventDefault();
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
  }, [forking, isTopmostModal, onCancel, turnId]);

  if (turnId === null) {
    return null;
  }

  return (
    <div className={styles.backdrop} onClick={(event) => {
      if (event.target === event.currentTarget && !forking) {
        onCancel();
      }
    }}>
      <section
        aria-busy={forking || undefined}
        aria-describedby={descriptionId}
        aria-labelledby={titleId}
        aria-modal="true"
        className={styles.dialog}
        ref={dialogRef}
        role="dialog"
        tabIndex={-1}
      >
        <div className={styles.content}>
          <div aria-hidden="true" className={styles.icon}>↗</div>
          <div>
            <h2 id={titleId}>从历史回答分叉？</h2>
            <div id={descriptionId}>
              <p>将以这条回答所在回合作为边界创建新会话</p>
              <p className={styles.detail}>当前窗口会打开新分支，原会话不会被修改</p>
            </div>
          </div>
        </div>
        {error === null ? null : <div className={styles.error} role="alert">{error}</div>}
        <div className={styles.actions}>
          <button disabled={forking} onClick={onCancel} ref={cancelRef} type="button">取消</button>
          <button className={styles.primaryButton} disabled={forking} onClick={() => onConfirm(turnId)} type="button">
            {forking ? "正在创建" : "创建分支"}
          </button>
        </div>
      </section>
    </div>
  );
}
