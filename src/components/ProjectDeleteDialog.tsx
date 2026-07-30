import { useEffect, useId, useLayoutEffect, useRef } from "react";

import { useModalLayer } from "./modalStack";
import styles from "./DeleteDialog.module.css";

export interface ProjectDeleteDialogProps {
  readonly deleting: boolean;
  readonly directory: string | null;
  readonly error: string | null;
  readonly onCancel: () => void;
  readonly onConfirm: (directory: string) => void;
}

export function ProjectDeleteDialog({
  deleting,
  directory,
  error,
  onCancel,
  onConfirm,
}: ProjectDeleteDialogProps) {
  const titleId = useId();
  const descriptionId = useId();
  const dialogRef = useRef<HTMLElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const isTopmostModal = useModalLayer(directory !== null);

  useLayoutEffect(() => {
    if (directory === null) {
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
  }, [directory]);

  useLayoutEffect(() => {
    if (directory === null) {
      return;
    }
    if (deleting) {
      dialogRef.current?.focus();
    } else if (document.activeElement === dialogRef.current) {
      cancelRef.current?.focus();
    }
  }, [deleting, directory]);

  useEffect(() => {
    if (directory === null) {
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
      const buttons = [
        ...(dialogRef.current?.querySelectorAll<HTMLButtonElement>(
          "button:not(:disabled)",
        ) ?? []),
      ];
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
  }, [deleting, directory, isTopmostModal, onCancel]);

  if (directory === null) {
    return null;
  }

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
            <h2 id={titleId}>删除受信任项目？</h2>
            <div id={descriptionId}>
              <p>确定要从受信任项目中删除此目录吗？</p>
              <p className={styles.url}>{directory}</p>
              <p className={styles.warning}>
                这不会删除项目文件，再次使用时可能需要重新确认信任
              </p>
            </div>
          </div>
        </div>
        {error === null ? null : (
          <div className={styles.error} role="alert">{error}</div>
        )}
        <div className={styles.actions}>
          <button
            disabled={deleting}
            onClick={cancel}
            ref={cancelRef}
            type="button"
          >
            取消
          </button>
          <button
            className={styles.deleteButton}
            disabled={deleting}
            onClick={() => onConfirm(directory)}
            type="button"
          >
            {deleting ? "正在删除" : "删除项目"}
          </button>
        </div>
      </section>
    </div>
  );
}
