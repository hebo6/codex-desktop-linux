import { useEffect, useId, useLayoutEffect, useRef } from "react";

import { useModalLayer } from "./modalStack";
import styles from "./DeleteDialog.module.css";

export interface TabCloseConfirmation {
  readonly draftCount: number;
  readonly kind: "others" | "right";
  readonly tabCount: number;
}

export function TabCloseDialog({
  closing,
  confirmation,
  onCancel,
  onConfirm,
}: {
  readonly closing: boolean;
  readonly confirmation: TabCloseConfirmation | null;
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
}) {
  const titleId = useId();
  const descriptionId = useId();
  const dialogRef = useRef<HTMLElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const isTopmostModal = useModalLayer(confirmation !== null);

  useLayoutEffect(() => {
    if (confirmation === null) {
      return;
    }
    const previous = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    cancelRef.current?.focus();
    return () => {
      if (previous?.isConnected) {
        previous.focus();
      }
    };
  }, [confirmation]);

  useEffect(() => {
    if (confirmation === null) {
      return;
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!isTopmostModal()) {
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        if (!closing) {
          onCancel();
        }
        return;
      }
      if (event.key !== "Tab") {
        return;
      }
      const buttons = Array.from(
        dialogRef.current?.querySelectorAll<HTMLButtonElement>(
          "button:not(:disabled)",
        ) ?? [],
      );
      const first = buttons[0];
      const last = buttons.at(-1);
      if (first === undefined || last === undefined) {
        event.preventDefault();
        dialogRef.current?.focus();
      } else if (
        event.shiftKey &&
        (document.activeElement === first ||
          !dialogRef.current?.contains(document.activeElement))
      ) {
        event.preventDefault();
        last.focus();
      } else if (
        !event.shiftKey &&
        (document.activeElement === last ||
          !dialogRef.current?.contains(document.activeElement))
      ) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [closing, confirmation, isTopmostModal, onCancel]);

  if (confirmation === null) {
    return null;
  }

  const target = confirmation.kind === "others" ? "其他" : "右侧";
  const cancel = () => {
    if (!closing) {
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
        aria-busy={closing || undefined}
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
            <h2 id={titleId}>关闭多个标签页？</h2>
            <div id={descriptionId}>
              <p>确定要关闭{target} {confirmation.tabCount} 个标签页吗？</p>
              <p className={styles.warning}>
                其中 {confirmation.draftCount} 个新任务包含未发送内容，关闭后无法恢复
              </p>
            </div>
          </div>
        </div>
        <div className={styles.actions}>
          <button
            disabled={closing}
            onClick={cancel}
            ref={cancelRef}
            type="button"
          >
            取消
          </button>
          <button
            className={styles.deleteButton}
            disabled={closing}
            onClick={onConfirm}
            type="button"
          >
            {closing ? "正在关闭" : "仍然关闭"}
          </button>
        </div>
      </section>
    </div>
  );
}
