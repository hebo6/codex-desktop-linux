import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";

import type { ExtractedLink } from "../content/linkResolver";
import { useModalLayer } from "./modalStack";
import styles from "./ThreadDeleteDialog.module.css";

export function ExternalLinkDialog({
  link,
  opening,
  onCancel,
  onConfirm,
}: {
  readonly link: ExtractedLink | null;
  readonly opening: boolean;
  readonly onCancel: () => void;
  readonly onConfirm: (trustDomain: boolean) => void;
}) {
  const titleId = useId();
  const descriptionId = useId();
  const cancelRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const [trustDomain, setTrustDomain] = useState(false);
  const isTopmostModal = useModalLayer(link !== null);

  useLayoutEffect(() => {
    if (link === null) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setTrustDomain(false);
    cancelRef.current?.focus();
    return () => { if (previous?.isConnected) previous.focus(); };
  }, [link]);

  useEffect(() => {
    if (link === null) return;
    const handler = (event: KeyboardEvent) => {
      if (!isTopmostModal()) {
        return;
      }
      if (event.key === "Escape" && !opening) {
        event.preventDefault();
        onCancel();
        return;
      }
      if (event.key !== "Tab" || dialogRef.current === null) {
        return;
      }
      const focusable = [...dialogRef.current.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])',
      )];
      const first = focusable[0];
      const last = focusable.at(-1);
      if (first === undefined || last === undefined) {
        return;
      }
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [isTopmostModal, link, onCancel, opening]);

  if (link === null) return null;
  return (
    <div className={styles.backdrop} onClick={(event) => {
      if (event.target === event.currentTarget && !opening) onCancel();
    }}>
      <section aria-describedby={descriptionId} aria-labelledby={titleId} aria-modal="true" className={styles.dialog} ref={dialogRef} role="dialog">
        <div className={styles.content}>
          <div aria-hidden="true" className={styles.icon}>↗</div>
          <div>
            <h2 id={titleId}>在系统浏览器中打开网页？</h2>
            <div id={descriptionId}>
              <p className={styles.detail}>域名：{link.domain}</p>
              <p className={styles.url}>{link.url}</p>
              <label className={styles.checkbox}><input checked={trustDomain} onChange={(event) => setTrustDomain(event.target.checked)} type="checkbox" />本次运行期间信任此域名</label>
            </div>
          </div>
        </div>
        <div className={styles.actions}>
          <button disabled={opening} onClick={onCancel} ref={cancelRef} type="button">取消</button>
          <button className={styles.primaryButton} disabled={opening} onClick={() => onConfirm(trustDomain)} type="button">{opening ? "正在打开" : "打开网页"}</button>
        </div>
      </section>
    </div>
  );
}
