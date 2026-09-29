import { useEffect, useId, useLayoutEffect, useRef } from "react";

import type { ProxyProfile, ServerProfile } from "../configuration";
import { isEscapeDismissal, isFocusTraversal } from "./keyboardEvents";
import { useModalLayer } from "./modalStack";
import serverStyles from "./ServerEditorDialog.module.css";

export function ProxyDeleteDialog({ proxy, servers, deleting, error, onCancel, onConfirm }: { readonly proxy: ProxyProfile | null; readonly servers: readonly ServerProfile[]; readonly deleting: boolean; readonly error: string | null; readonly onCancel: () => void; readonly onConfirm: (proxy: ProxyProfile) => void }) {
  const titleId = useId();
  const dialogRef = useRef<HTMLElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const isTopmostModal = useModalLayer(proxy !== null);

  useLayoutEffect(() => {
    if (proxy === null) return;
    const previous = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    cancelRef.current?.focus();
    return () => {
      if (previous?.isConnected) previous.focus();
    };
  }, [proxy?.proxyId]);

  useLayoutEffect(() => {
    if (proxy === null) return;
    if (deleting) {
      dialogRef.current?.focus();
    } else if (document.activeElement === dialogRef.current) {
      cancelRef.current?.focus();
    }
  }, [deleting, proxy?.proxyId]);

  useEffect(() => {
    if (proxy === null) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!isTopmostModal()) return;
      if (isEscapeDismissal(event)) {
        event.preventDefault();
        event.stopImmediatePropagation();
        if (!deleting) onCancel();
        return;
      }
      if (!isFocusTraversal(event)) return;
      const dialog = dialogRef.current;
      if (dialog === null) return;
      const buttons = [...dialog.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")];
      const first = buttons[0];
      const last = buttons.at(-1);
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
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [deleting, isTopmostModal, onCancel, proxy]);

  if (proxy === null) return null;
  const referenced = servers.filter((server) => server.configuration.type === "remoteWebSocket" && server.configuration.proxyId === proxy.proxyId);
  return <div className={serverStyles.backdrop}><section aria-busy={deleting || undefined} aria-labelledby={titleId} aria-modal="true" className={serverStyles.dialog} ref={dialogRef} role="alertdialog" tabIndex={-1}><header className={serverStyles.header}><div><h2 id={titleId}>删除代理</h2><p>此操作只删除本机配置与关联凭据</p></div></header><div className={serverStyles.body}><p>确定删除“{proxy.name}”吗？</p>{referenced.length > 0 ? <div className={serverStyles.submitError} role="alert">代理仍被以下服务器引用：{referenced.map(({ name }) => name).join("、")}。请先编辑这些服务器并改为直连或其他代理</div> : null}{error ? <div className={serverStyles.submitError} role="alert">{error}</div> : null}</div><footer className={serverStyles.footer}><button className={serverStyles.secondaryButton} disabled={deleting} onClick={onCancel} ref={cancelRef} type="button">取消</button><button className={serverStyles.primaryButton} disabled={deleting || referenced.length > 0} onClick={() => onConfirm(proxy)} type="button">{deleting ? "正在删除" : "确认删除"}</button></footer></section></div>;
}
