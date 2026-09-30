import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { renderMermaid } from "../content/mermaid";
import { useBlobUrl } from "../content/useBlobUrl";
import { useColorScheme, type ColorScheme } from "../content/useColorScheme";
import { isEscapeDismissal, isFocusTraversal } from "./keyboardEvents";
import { useModalLayer } from "./modalStack";
import styles from "./MermaidPreview.module.css";

type PreviewResult = {
  readonly source: string;
  readonly theme: ColorScheme;
} & (
  | { readonly blob: Blob; readonly error: null }
  | { readonly blob: null; readonly error: string }
);

export function MermaidPreview({ source }: { readonly source: string }) {
  const theme = useColorScheme();
  const [result, setResult] = useState<PreviewResult | null>(null);
  const [expanded, setExpanded] = useState(false);
  const current = result?.source === source && result.theme === theme ? result : null;

  useEffect(() => {
    let active = true;
    void renderMermaid(source, theme).then(
      (svg) => {
        if (active) {
          setResult({ source, theme, blob: new Blob([svg], { type: "image/svg+xml" }), error: null });
        }
      },
      (error: unknown) => {
        if (active) {
          setResult({
            source,
            theme,
            blob: null,
            error: error instanceof Error ? error.message : "请检查 Mermaid 语法后重试",
          });
        }
      },
    );
    return () => { active = false; };
  }, [source, theme]);

  return (
    <div className={styles.preview}>
      <MermaidContent result={current} source={source} />
      <div className={styles.actions}>
        <button className={styles.button} onClick={() => setExpanded(true)} type="button">放大查看</button>
      </div>
      {expanded ? createPortal(
        <MermaidZoomDialog result={current} source={source} onClose={() => setExpanded(false)} />,
        document.body,
      ) : null}
    </div>
  );
}

function MermaidContent({ result, source, zoom }: {
  readonly result: PreviewResult | null;
  readonly source: string;
  readonly zoom?: number;
}) {
  if (result === null) {
    return <div className={styles.pending} role="status">正在生成图表…</div>;
  }
  if (result.error !== null) {
    return (
      <div>
        <p className={styles.error} role="alert">图表生成失败：{result.error}</p>
        <pre className={styles.source}><code>{source}</code></pre>
      </div>
    );
  }
  return <MermaidImage blob={result.blob} key={`${result.theme}:${result.source}`} zoom={zoom} />;
}

function MermaidImage({ blob, zoom }: { readonly blob: Blob; readonly zoom: number | undefined }) {
  // 每份渲染结果拥有独立的 URL 生命周期，换图时不会短暂复用上一张图片的地址
  const imageUrl = useBlobUrl(blob);
  if (imageUrl === null) {
    return <div className={styles.pending} role="status">正在生成图表…</div>;
  }
  return (
    <img
      alt="Mermaid 图表"
      className={zoom === undefined ? styles.image : styles.zoomedImage}
      src={imageUrl}
      style={zoom === undefined ? undefined : { width: `${zoom}%` }}
    />
  );
}

function MermaidZoomDialog({ result, source, onClose }: {
  readonly result: PreviewResult | null;
  readonly source: string;
  readonly onClose: () => void;
}) {
  const [zoom, setZoom] = useState(100);
  const titleId = useId();
  const dialogRef = useRef<HTMLElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const isTopmostModal = useModalLayer();

  useLayoutEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeRef.current?.focus();
    return () => { if (previous?.isConnected) previous.focus(); };
  }, []);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!isTopmostModal()) return;
      if (isEscapeDismissal(event)) {
        event.preventDefault();
        onClose();
        return;
      }
      if (!isFocusTraversal(event) || dialogRef.current === null) return;
      const focusable = [...dialogRef.current.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [tabindex]:not([tabindex="-1"])',
      )];
      const first = focusable[0];
      const last = focusable.at(-1);
      if (first === undefined || last === undefined) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [isTopmostModal, onClose]);

  return (
    <div className={styles.backdrop} onMouseDown={(event) => {
      if (event.target === event.currentTarget && isTopmostModal()) onClose();
    }}>
      <section aria-labelledby={titleId} aria-modal="true" className={styles.dialog} ref={dialogRef} role="dialog">
        <header className={styles.header}>
          <h2 id={titleId}>Mermaid 图表</h2>
          <div className={styles.controls}>
            <button aria-label="缩小图表" className={styles.button} disabled={zoom === 25} onClick={() => setZoom((value) => value - 25)} title="缩小图表" type="button">−</button>
            <output aria-label="缩放比例" className={styles.zoom}>{zoom}%</output>
            <button aria-label="放大图表" className={styles.button} disabled={zoom === 400} onClick={() => setZoom((value) => value + 25)} title="放大图表" type="button">＋</button>
            <button aria-label="关闭图表预览" className={styles.button} onClick={onClose} ref={closeRef} type="button">关闭</button>
          </div>
        </header>
        <div aria-label="图表查看区域" className={styles.canvas} role="region" tabIndex={0}>
          <MermaidContent result={result} source={source} zoom={zoom} />
        </div>
      </section>
    </div>
  );
}
