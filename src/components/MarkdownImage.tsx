import { createContext, useContext, useEffect, useState } from "react";

import type { FileClient } from "../appServer";
import { loadMarkdownImage, type MarkdownImageResource } from "../content/markdownImage";
import { useBlobUrl } from "../content/useBlobUrl";
import styles from "./SafeMarkdown.module.css";

export const MarkdownImageContext = createContext<{
  readonly client: FileClient | null;
  readonly cwd: string | null;
}>({ client: null, cwd: null });

export function MarkdownImage({ source, alt, title, onOpenLink, insideLink }: {
  readonly source: string;
  readonly alt: string;
  readonly title?: string;
  readonly onOpenLink?: (target: string) => void;
  readonly insideLink: boolean;
}) {
  const { client, cwd } = useContext(MarkdownImageContext);
  // 地址变化时重新挂载，旧请求和 Blob 不进入新图片的状态
  return <ImageLoader key={source} source={source} alt={alt} title={title}
    client={client} cwd={cwd} onOpenLink={onOpenLink} insideLink={insideLink} />;
}

function ImageLoader({ source, alt, title, client, cwd, onOpenLink, insideLink }: {
  readonly source: string;
  readonly alt: string;
  readonly title: string | undefined;
  readonly client: FileClient | null;
  readonly cwd: string | null;
  readonly onOpenLink: ((target: string) => void) | undefined;
  readonly insideLink: boolean;
}) {
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<{
    readonly client: FileClient | null;
    readonly cwd: string | null;
    readonly image: MarkdownImageResource | null;
    readonly error: string | null;
  } | null>(null);
  const current = result?.client === client && result.cwd === cwd ? result : null;
  const label = alt.length === 0 ? "图片" : alt;

  useEffect(() => {
    let disposed = false;
    setResult(null);
    void loadMarkdownImage(source, client, cwd).then(
      (image) => { if (!disposed) setResult({ client, cwd, image, error: null }); },
      (error: unknown) => {
        if (!disposed) setResult({ client, cwd, image: null, error: error instanceof Error ? error.message : typeof error === "string" ? error : "无法读取图片" });
      },
    );
    return () => { disposed = true; };
  }, [source, client, cwd, attempt]);

  if (current?.error != null) {
    return <span className={styles.imageStatus}>
      <span role="status">{label}：{current.error}</span>
      {insideLink ? null : <button onClick={() => setAttempt((value) => value + 1)} type="button">重试</button>}
    </span>;
  }
  if (current?.image == null) {
    return <span className={styles.imageStatus} role="status">正在加载图片：{label}</span>;
  }
  const image = current.image;
  return <LoadedImage image={image} label={label} title={title}
    onError={() => setResult({ client, cwd, image: null, error: "图片无法解码" })}
    onOpen={insideLink || onOpenLink === undefined ? undefined : () => onOpenLink(image.target)} />;
}

function LoadedImage({ image, label, title, onError, onOpen }: {
  readonly image: MarkdownImageResource;
  readonly label: string;
  readonly title: string | undefined;
  readonly onError: () => void;
  readonly onOpen: (() => void) | undefined;
}) {
  const url = useBlobUrl(image.blob);
  if (url === null) return <span className={styles.imageStatus} role="status">正在加载图片：{label}</span>;
  const content = <img alt={label} className={styles.image} decoding="async" loading="lazy" onError={onError} src={url} title={title} />;
  return onOpen === undefined ? content : (
    <button aria-label={`查看图片：${label}`} className={styles.imageButton} onClick={onOpen} type="button">{content}</button>
  );
}
