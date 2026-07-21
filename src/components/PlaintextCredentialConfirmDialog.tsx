import { useEffect, useId, useLayoutEffect, useRef } from "react";

import { useModalLayer } from "./modalStack";
import styles from "./PlaintextCredentialConfirmDialog.module.css";

export interface PlaintextCredentialConfirmDialogProps {
  readonly open: boolean;
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
}

export function PlaintextCredentialConfirmDialog({
  open,
  onCancel,
  onConfirm,
}: PlaintextCredentialConfirmDialogProps) {
  const titleId = useId();
  const descriptionId = useId();
  const dialogRef = useRef<HTMLElement>(null);
  const cancelButtonRef = useRef<HTMLButtonElement>(null);
  const isTopmostModal = useModalLayer(open);

  useLayoutEffect(() => {
    if (!open) return;
    const previouslyFocused =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    cancelButtonRef.current?.focus();
    return () => {
      if (previouslyFocused?.isConnected) previouslyFocused.focus();
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!isTopmostModal()) return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopImmediatePropagation();
        onCancel();
        return;
      }
      if (event.key !== "Tab" || dialogRef.current === null) return;
      const buttons = Array.from(
        dialogRef.current.querySelectorAll<HTMLButtonElement>(
          "button:not(:disabled)",
        ),
      );
      const first = buttons[0];
      const last = buttons.at(-1);
      if (first === undefined || last === undefined) {
        event.preventDefault();
        dialogRef.current.focus();
      } else if (!dialogRef.current.contains(document.activeElement)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
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
  }, [isTopmostModal, onCancel, open]);

  if (!open) return null;

  return (
    <div
      className={styles.backdrop}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && isTopmostModal()) onCancel();
      }}
    >
      <section
        aria-describedby={descriptionId}
        aria-labelledby={titleId}
        aria-modal="true"
        className={styles.dialog}
        ref={dialogRef}
        role="alertdialog"
        tabIndex={-1}
      >
        <div className={styles.content}>
          <div aria-hidden="true" className={styles.icon}>
            !
          </div>
          <div className={styles.copy}>
            <h2 id={titleId}>使用明文文件保存凭据？</h2>
            <div id={descriptionId}>
              <p>
                系统 Secret Service 当前不可用。本次凭据将不加密地写入应用数据目录，仅依赖本机文件权限保护
              </p>
              <p className={styles.detail}>
                凭据目录权限为 0700，文件权限为 0600。拥有当前用户权限或更高系统权限的进程仍可能读取凭据
              </p>
            </div>
          </div>
        </div>
        <div className={styles.actions}>
          <button onClick={onCancel} ref={cancelButtonRef} type="button">
            返回编辑
          </button>
          <button
            className={styles.confirmButton}
            onClick={onConfirm}
            type="button"
          >
            确认使用明文文件
          </button>
        </div>
      </section>
    </div>
  );
}
