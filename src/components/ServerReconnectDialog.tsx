import { useEffect, useId, useLayoutEffect, useRef } from "react";

import { useModalLayer } from "./modalStack";
import styles from "./ServerReconnectDialog.module.css";

export interface ServerReconnectDialogProps {
  readonly serverName: string | null;
  readonly onReconnect: () => void;
  readonly onLater: () => void;
}

export function ServerReconnectDialog({
  serverName,
  onReconnect,
  onLater,
}: ServerReconnectDialogProps) {
  const titleId = useId();
  const descriptionId = useId();
  const dialogRef = useRef<HTMLElement>(null);
  const reconnectButtonRef = useRef<HTMLButtonElement>(null);
  const open = serverName !== null;
  const isTopmostModal = useModalLayer(open);

  useLayoutEffect(() => {
    if (!open) {
      return;
    }

    const previouslyFocused =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    reconnectButtonRef.current?.focus();
    return () => {
      if (previouslyFocused?.isConnected) {
        previouslyFocused.focus();
      }
    };
  }, [open]);

  useEffect(() => {
    if (!open) {
      return;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (!isTopmostModal()) {
        return;
      }
      if (event.key === "Tab") {
        const dialog = dialogRef.current;
        if (dialog === null) {
          return;
        }
        const focusable = Array.from(
          dialog.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"),
        );
        const first = focusable[0];
        const last = focusable.at(-1);
        if (first === undefined || last === undefined) {
          event.preventDefault();
          dialog.focus();
        } else if (!dialog.contains(document.activeElement)) {
          event.preventDefault();
          (event.shiftKey ? last : first).focus();
        } else if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
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
      onLater();
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [isTopmostModal, onLater, open]);

  if (serverName === null) {
    return null;
  }

  return (
    <div
      className={styles.backdrop}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && isTopmostModal()) {
          onLater();
        }
      }}
    >
      <section
        aria-describedby={descriptionId}
        aria-labelledby={titleId}
        aria-modal="true"
        className={styles.dialog}
        ref={dialogRef}
        role="dialog"
        tabIndex={-1}
      >
        <div className={styles.content}>
          <div aria-hidden="true" className={styles.reconnectIcon}>
            <svg viewBox="0 0 24 24">
              <path d="M20 7v5h-5" />
              <path d="M4 17v-5h5" />
              <path d="M6.1 8.5A7 7 0 0 1 18.7 7L20 12" />
              <path d="M17.9 15.5A7 7 0 0 1 5.3 17L4 12" />
            </svg>
          </div>

          <div className={styles.copy}>
            <h2 id={titleId}>立即重连服务器？</h2>
            <div id={descriptionId}>
              <p>
                服务器 <strong>“{serverName}”</strong>{" "}
                的配置已保存，现有连接仍在使用保存前的配置
              </p>
              <p className={styles.consequence}>
                立即重连会中断现有连接，并影响所有共享该连接的窗口；选择稍后应用则在下次连接时使用新配置
              </p>
            </div>
          </div>
        </div>

        <div className={styles.actions}>
          <button
            className={styles.laterButton}
            onClick={onLater}
            type="button"
          >
            稍后应用
          </button>
          <button
            className={styles.reconnectButton}
            onClick={onReconnect}
            ref={reconnectButtonRef}
            type="button"
          >
            立即重连
          </button>
        </div>
      </section>
    </div>
  );
}
