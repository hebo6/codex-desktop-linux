import { useEffect, useId, useLayoutEffect, useRef } from "react";

import type { ServerId, ServerProfile } from "../configuration";
import { useModalLayer } from "./modalStack";
import styles from "./ServerDeleteDialog.module.css";

export interface ServerDeleteDialogProps {
  readonly server: ServerProfile | null;
  readonly affectedWindowCount: number;
  readonly checkingWindowReferences: boolean;
  readonly saving: boolean;
  readonly errorSummary: string | null;
  readonly onCancel: () => void;
  readonly onConfirm: (serverId: ServerId, expectedVersion: number) => void;
}

export function ServerDeleteDialog({
  server,
  affectedWindowCount,
  checkingWindowReferences,
  saving,
  errorSummary,
  onCancel,
  onConfirm,
}: ServerDeleteDialogProps) {
  const titleId = useId();
  const descriptionId = useId();
  const dialogRef = useRef<HTMLElement>(null);
  const cancelButtonRef = useRef<HTMLButtonElement>(null);
  const isTopmostModal = useModalLayer(server !== null);
  const inUse = affectedWindowCount > 0;

  useLayoutEffect(() => {
    if (!server) {
      return;
    }

    const previouslyFocused =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    cancelButtonRef.current?.focus();
    return () => {
      if (previouslyFocused?.isConnected) {
        previouslyFocused.focus();
      }
    };
  }, [server?.serverId]);

  useLayoutEffect(() => {
    if (!server) {
      return;
    }
    if (saving) {
      dialogRef.current?.focus();
    } else if (document.activeElement === dialogRef.current) {
      cancelButtonRef.current?.focus();
    }
  }, [saving, server?.serverId]);

  useEffect(() => {
    if (!server) {
      return;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (!isTopmostModal()) {
        return;
      }
      if (event.key === "Tab") {
        const dialog = dialogRef.current;
        if (!dialog) {
          return;
        }
        const focusable = Array.from(
          dialog.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"),
        );
        if (focusable.length === 0) {
          event.preventDefault();
          dialog.focus();
          return;
        }

        const first = focusable[0]!;
        const last = focusable.at(-1)!;
        const activeElement = document.activeElement;
        if (
          event.shiftKey &&
          (activeElement === first || !dialog.contains(activeElement))
        ) {
          event.preventDefault();
          last.focus();
        } else if (
          !event.shiftKey &&
          (activeElement === last || !dialog.contains(activeElement))
        ) {
          event.preventDefault();
          first.focus();
        }
        return;
      }

      if (event.key !== "Escape") {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      if (!saving) {
        onCancel();
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [isTopmostModal, onCancel, saving, server]);

  if (!server) {
    return null;
  }

  const cancel = () => {
    if (!saving) {
      onCancel();
    }
  };

  const confirm = () => {
    if (!inUse && !checkingWindowReferences && !saving) {
      onConfirm(server.serverId, server.version);
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
        aria-busy={saving || checkingWindowReferences || undefined}
        aria-describedby={descriptionId}
        aria-labelledby={titleId}
        aria-modal="true"
        className={styles.dialog}
        ref={dialogRef}
        role="dialog"
        tabIndex={-1}
      >
        <div className={styles.content}>
          <div aria-hidden="true" className={styles.dangerIcon}>
            <svg viewBox="0 0 24 24">
              <path d="M12 8v5M12 17h.01" />
              <path d="M10.3 4.8 3.2 17.1A2 2 0 0 0 4.9 20h14.2a2 2 0 0 0 1.7-2.9L13.7 4.8a2 2 0 0 0-3.4 0Z" />
            </svg>
          </div>

          <div className={styles.copy}>
            <h2 id={titleId}>删除服务器？</h2>
            <div id={descriptionId}>
              <p>
                确定要删除服务器 <strong>“{server.name}”</strong> 吗？
              </p>
              <p className={styles.consequence}>
                只会删除此设备上的连接配置和已保存凭据，不会删除服务端会话或任何远程文件
              </p>
              {inUse ? (
                <div className={styles.inUseNotice}>
                  <strong>此服务器正被 {affectedWindowCount} 个窗口使用</strong>
                  <span>
                    必须先关闭相关窗口或将这些窗口切换到其他服务器，然后才能删除
                  </span>
                </div>
              ) : null}
            </div>
          </div>
        </div>

        {errorSummary ? (
          <div className={styles.error} role="alert">
            {errorSummary}
          </div>
        ) : null}

        <div className={styles.actions}>
          <button
            className={styles.cancelButton}
            disabled={saving}
            onClick={cancel}
            ref={cancelButtonRef}
            type="button"
          >
            取消
          </button>
          <button
            className={styles.deleteButton}
            disabled={inUse || checkingWindowReferences || saving}
            onClick={confirm}
            type="button"
          >
            {saving
              ? "正在删除"
              : checkingWindowReferences
                ? "正在确认"
                : "删除服务器"}
          </button>
        </div>
      </section>
    </div>
  );
}
