import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type WheelEvent as ReactWheelEvent,
} from "react";

import type { FileClient } from "../appServer";
import {
  contentProcessor as sharedContentProcessor,
  type ContentProcessor,
} from "../content/contentProcessing";
import { sanitizeSvg } from "../content/sanitizeSvg";
import {
  browserBlobUrls,
  useBlobUrl,
  type BlobUrlFactory,
} from "../content/useBlobUrl";
import { saveRemoteFile } from "../transport/systemDialog";
import { useModalLayer } from "./modalStack";
import { SafeMarkdown } from "./SafeMarkdown";
import styles from "./FilePreviewDialog.module.css";

const MAX_PREVIEW_BYTES = 16 * 1024 * 1024;

export interface FilePreviewRequest {
  readonly path: string;
  readonly line?: number | null;
  readonly endLine?: number | null;
  readonly column?: number | null;
  readonly diff?: string | null;
}

interface LoadedFile {
  readonly dataBase64: string;
  readonly modifiedAtMs: number;
}

export function FilePreviewDialog({
  client,
  onClose,
  onOpenLink,
  request,
  serverName,
  workspacePath,
  defaultWrap = false,
  blobUrlFactory = browserBlobUrls,
  contentProcessor = sharedContentProcessor,
}: {
  readonly client: FileClient | null;
  readonly onClose: () => void;
  readonly onOpenLink?: (link: string) => void;
  readonly request: FilePreviewRequest | null;
  readonly serverName: string;
  readonly workspacePath?: string | null;
  readonly defaultWrap?: boolean;
  readonly blobUrlFactory?: BlobUrlFactory;
  readonly contentProcessor?: ContentProcessor;
}) {
  const titleId = useId();
  const dialogRef = useRef<HTMLElement>(null);
  const [loaded, setLoaded] = useState<LoadedFile | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [wrap, setWrap] = useState(defaultWrap);
  const [search, setSearch] = useState("");
  const [markdownView, setMarkdownView] = useState(true);
  const [zoom, setZoom] = useState(1);
  const [rotation, setRotation] = useState(0);
  const [imageFit, setImageFit] = useState(true);
  const [imagePan, setImagePan] = useState({ x: 0, y: 0 });
  const [imageSize, setImageSize] = useState({ width: 0, height: 0 });
  const [canPanImage, setCanPanImage] = useState(false);
  const imageViewportRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ pointerId: number; x: number; y: number; panX: number; panY: number } | null>(null);
  const [activeLine, setActiveLine] = useState<number | null>(null);
  const [activeEndLine, setActiveEndLine] = useState<number | null>(null);
  const [jumpLine, setJumpLine] = useState("");
  const [jumpError, setJumpError] = useState<string | null>(null);
  const [diffMode, setDiffMode] = useState<"unified" | "split">("unified");
  const [saving, setSaving] = useState(false);
  const [saveStatus, setSaveStatus] = useState<string | null>(null);
  const [formattedText, setFormattedText] = useState<string | null>(null);
  const [formattingJson, setFormattingJson] = useState(false);
  const [matchingLines, setMatchingLines] = useState<ReadonlySet<number>>(
    new Set(),
  );
  const [searchingText, setSearchingText] = useState(false);
  const isTopmostModal = useModalLayer(request !== null);

  useEffect(() => {
    setLoaded(null);
    setError(null);
    setSearch("");
    setWrap(defaultWrap);
    setZoom(1);
    setRotation(0);
    setImageFit(true);
    setImagePan({ x: 0, y: 0 });
    setImageSize({ width: 0, height: 0 });
    setCanPanImage(false);
    setActiveLine(request?.line ?? null);
    setActiveEndLine(request?.endLine ?? null);
    setJumpLine(request?.line === undefined || request.line === null ? "" : String(request.line));
    setJumpError(null);
    setDiffMode("unified");
    setSaveStatus(null);
    if (request === null) {
      setLoading(false);
      return;
    }
    if (client === null) {
      setLoading(false);
      setError("当前服务器连接不可用，无法读取文件");
      return;
    }
    let disposed = false;
    setLoading(true);
    void Promise.all([
      client.getMetadata(request.path).result,
      client.readFile(request.path).result,
    ]).then(
      ([metadata, response]) => {
        if (disposed) return;
        if (!metadata.isFile) {
          setError("此路径不是可预览的普通文件");
          setLoading(false);
          return;
        }
        setLoaded({ dataBase64: response.dataBase64, modifiedAtMs: metadata.modifiedAtMs });
        setLoading(false);
      },
      () => {
        if (!disposed) {
          setError("无法从当前服务器读取此文件");
          setLoading(false);
        }
      },
    );
    return () => {
      disposed = true;
    };
  }, [attempt, client, defaultWrap, request]);

  useEffect(() => {
    if (request === null) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialogRef.current?.focus();
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!isTopmostModal()) {
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
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
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      if (previous?.isConnected) previous.focus();
    };
  }, [isTopmostModal, onClose, request]);

  const decoded = useMemo(
    () => request === null || loaded === null ? null : decodePreview(request.path, loaded.dataBase64),
    [loaded, request],
  );
  const imageUrl = useBlobUrl(
    decoded?.type === "image" ? decoded.blob : null,
    blobUrlFactory,
  );
  const sourceText = decoded?.type === "text" ? decoded.text : null;

  useEffect(() => {
    setFormattedText(null);
    setFormattingJson(false);
    if (sourceText === null) return;
    if (request === null || !isJson(request.path)) {
      setFormattedText(sourceText);
      return;
    }
    let disposed = false;
    setFormattingJson(true);
    void contentProcessor.formatJson(sourceText).then(
      ({ text }) => {
        if (!disposed) {
          setFormattedText(text);
          setFormattingJson(false);
        }
      },
      () => {
        if (!disposed) {
          setFormattedText(sourceText);
          setFormattingJson(false);
        }
      },
    );
    return () => {
      disposed = true;
    };
  }, [contentProcessor, request, sourceText]);

  const displayedText = formattedText ?? sourceText;
  useEffect(() => {
    setMatchingLines(new Set());
    setSearchingText(false);
    if (displayedText === null || search.length === 0) return;
    let disposed = false;
    const timeout = window.setTimeout(() => {
      setSearchingText(true);
      void contentProcessor.findMatchingLines(displayedText, search).then(
        (matches) => {
          if (!disposed) {
            setMatchingLines(new Set(matches));
            setSearchingText(false);
          }
        },
        () => {
          if (!disposed) setSearchingText(false);
        },
      );
    }, 120);
    return () => {
      disposed = true;
      window.clearTimeout(timeout);
    };
  }, [contentProcessor, displayedText, search]);

  useEffect(() => {
    if (activeLine === null || decoded?.type !== "text") return;
    const target = document.getElementById(`preview-line-${activeLine}`);
    if (target !== null && typeof target.scrollIntoView === "function") {
      target.scrollIntoView({ block: "center" });
    }
  }, [activeLine, displayedText, decoded?.type]);

  useEffect(() => {
    if (decoded?.type !== "image") return;
    const update = () => {
      const viewport = imageViewportRef.current;
      if (viewport === null || imageSize.width === 0 || imageSize.height === 0) return;
      const fitScale = imageFit
        ? Math.min(
            1,
            viewport.clientWidth * 0.9 / imageSize.width,
            viewport.clientHeight * 0.9 / imageSize.height,
          )
        : 1;
      const rotated = rotation % 180 !== 0;
      const width = (rotated ? imageSize.height : imageSize.width) * fitScale * zoom;
      const height = (rotated ? imageSize.width : imageSize.height) * fitScale * zoom;
      const nextCanPan = width > viewport.clientWidth || height > viewport.clientHeight;
      setCanPanImage(nextCanPan);
      if (!nextCanPan) setImagePan({ x: 0, y: 0 });
    };
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, [decoded?.type, imageFit, imageSize, rotation, zoom]);

  if (request === null) {
    return null;
  }
  const name = fileName(request.path);
  const relativePath = relativeRemotePath(request.path, workspacePath);
  const language = languageForPath(request.path);
  const textLineCount = displayedText?.split(/\r?\n/u).length ?? 0;
  const jumpToLine = () => {
    const line = Number(jumpLine);
    if (!Number.isSafeInteger(line) || line < 1 || line > textLineCount) {
      setJumpError(`请输入 1 到 ${Math.max(textLineCount, 1)} 之间的行号`);
      return;
    }
    setJumpError(null);
    setActiveLine(line);
    setActiveEndLine(null);
  };
  const updateZoom = (nextZoom: number, clientX?: number, clientY?: number) => {
    setZoom((current) => {
      const next = Math.min(5, Math.max(0.2, nextZoom));
      const viewport = imageViewportRef.current;
      if (viewport !== null && clientX !== undefined && clientY !== undefined && next !== current) {
        const bounds = viewport.getBoundingClientRect();
        const x = clientX - bounds.left - bounds.width / 2;
        const y = clientY - bounds.top - bounds.height / 2;
        const ratio = next / current;
        setImagePan((pan) => ({
          x: x - (x - pan.x) * ratio,
          y: y - (y - pan.y) * ratio,
        }));
      }
      return next;
    });
  };
  const zoomAtPointer = (event: ReactWheelEvent<HTMLDivElement>) => {
    if (!event.ctrlKey && !event.metaKey) return;
    event.preventDefault();
    updateZoom(zoom + (event.deltaY < 0 ? 0.2 : -0.2), event.clientX, event.clientY);
  };
  const beginPan = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!canPanImage || event.button !== 0) return;
    dragRef.current = {
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      panX: imagePan.x,
      panY: imagePan.y,
    };
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };
  const movePan = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (drag === null || drag.pointerId !== event.pointerId) return;
    setImagePan({
      x: drag.panX + event.clientX - drag.x,
      y: drag.panY + event.clientY - drag.y,
    });
  };
  const endPan = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (dragRef.current?.pointerId === event.pointerId) dragRef.current = null;
  };
  const save = async () => {
    if (loaded === null || saving) return;
    const size = decodedSize(loaded.dataBase64);
    const allowLarge = size > 256 * 1024 * 1024
      ? window.confirm(`此文件大小为 ${formatBytes(size)}，超过 256 MiB 默认限制，仍要继续保存吗？`)
      : false;
    if (size > 256 * 1024 * 1024 && !allowLarge) return;
    setSaving(true);
    setSaveStatus(null);
    try {
      const saved = await saveRemoteFile(loaded.dataBase64, name, allowLarge);
      setSaveStatus(saved === null ? null : "文件已保存");
    } catch {
      setSaveStatus("无法保存此文件");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className={styles.backdrop}>
      <section aria-labelledby={titleId} aria-modal="true" className={styles.dialog} ref={dialogRef} role="dialog" tabIndex={-1}>
        <header className={styles.header}>
          <div><h2 id={titleId}>{name}</h2><p>{serverName} · {relativePath}</p></div>
          <div className={styles.headerActions}>
            <button disabled={loaded === null || saving} onClick={() => void save()} type="button">{saving ? "正在保存" : "另存为"}</button>
            <button aria-label="关闭文件预览" onClick={onClose} type="button">×</button>
          </div>
        </header>
        {saveStatus === null ? null : <div className={styles.status} role="status">{saveStatus}</div>}
        <div className={styles.meta}>
          <span>{decoded === null ? "正在识别" : kindLabel(decoded.type)}</span>
          <span>{loaded === null ? "大小未知" : formatBytes(decodedSize(loaded.dataBase64))}</span>
          {decoded?.type === "text" ? <><span>{language}</span><span>UTF-8</span><span>{lineEnding(decoded.text)}</span></> : null}
          {loaded !== null && loaded.modifiedAtMs > 0 ? <span>{new Date(loaded.modifiedAtMs).toLocaleString()}</span> : null}
        </div>
        <div className={styles.toolbar}>
          {request.diff !== undefined && request.diff !== null ? (
            <>
              <button aria-pressed={diffMode === "unified"} onClick={() => setDiffMode("unified")} type="button">统一差异</button>
              <button aria-pressed={diffMode === "split"} onClick={() => setDiffMode("split")} type="button">左右对照</button>
            </>
          ) : decoded?.type === "text" ? (
            <>
              <input aria-label="在文件中查找" onChange={(event) => setSearch(event.target.value)} placeholder="查找" type="search" value={search} />
              {search.length === 0 ? null : <span role="status">{searchingText ? "正在搜索" : `${matchingLines.size} 行匹配`}</span>}
              {formattingJson ? <span role="status">正在格式化 JSON</span> : null}
              <label className={styles.jumpLine}><span className={styles.srOnly}>跳转到行</span><input aria-label="跳转到行" min={1} onChange={(event) => setJumpLine(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") jumpToLine(); }} placeholder="行号" type="number" value={jumpLine} /><button onClick={jumpToLine} type="button">跳转</button></label>
              {jumpError === null ? null : <span className={styles.inlineError} role="alert">{jumpError}</span>}
              <button onClick={() => void navigator.clipboard.writeText(window.getSelection()?.toString() ?? "")} type="button">复制选区</button>
              <button aria-pressed={wrap} onClick={() => setWrap((value) => !value)} type="button">{wrap ? "不折行" : "折行"}</button>
              {isMarkdown(request.path) ? <button aria-pressed={markdownView} onClick={() => setMarkdownView((value) => !value)} type="button">{markdownView ? "查看源码" : "渲染预览"}</button> : null}
            </>
          ) : decoded?.type === "image" ? (
            <>
              <button onClick={() => updateZoom(zoom - 0.2)} type="button">缩小</button>
              <button onClick={() => updateZoom(zoom + 0.2)} type="button">放大</button>
              <button aria-pressed={imageFit} onClick={() => { setImageFit(true); setZoom(1); setRotation(0); setImagePan({ x: 0, y: 0 }); }} type="button">适应窗口</button>
              <button aria-pressed={!imageFit} onClick={() => { setImageFit(false); setZoom(1); setImagePan({ x: 0, y: 0 }); }} type="button">原始尺寸</button>
              <button onClick={() => { setRotation((value) => (value + 90) % 360); setImagePan({ x: 0, y: 0 }); }} type="button">旋转</button>
              <span>{Math.round(zoom * 100)}%</span>
            </>
          ) : null}
          <button onClick={() => void navigator.clipboard.writeText(request.path)} type="button">复制路径</button>
        </div>
        <main className={styles.content}>
          {request.diff !== undefined && request.diff !== null ? (
            <DiffView diff={request.diff} mode={diffMode} />
          ) : loading ? <div className={styles.placeholder} role="status">正在读取 {name}</div> : error !== null ? (
            <div className={styles.placeholder} role="alert"><strong>{error}</strong><button onClick={() => setAttempt((value) => value + 1)} type="button">重试</button></div>
          ) : decoded?.type === "tooLarge" ? (
            <div className={styles.placeholder}><strong>文件超过 16 MiB 预览上限</strong><span>仍可使用另存为保存完整内容</span></div>
          ) : decoded?.type === "binary" ? (
            <div className={styles.placeholder}><strong>此文件不是有效的 UTF-8 文本或支持的图片</strong><span>为避免在 WebView 中执行未知内容，仅提供另存为</span></div>
          ) : decoded?.type === "image" && imageUrl !== null ? (
            <div className={styles.imageViewport} data-pannable={canPanImage} onPointerCancel={endPan} onPointerDown={beginPan} onPointerMove={movePan} onPointerUp={endPan} onWheel={zoomAtPointer} ref={imageViewportRef}><img alt={name} data-fit={imageFit} decoding="async" draggable={false} onLoad={(event) => setImageSize({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })} src={imageUrl} style={{ transform: `translate(${imagePan.x}px, ${imagePan.y}px) scale(${zoom}) rotate(${rotation}deg)` }} /></div>
          ) : decoded?.type === "image" ? (
            <div className={styles.placeholder} role="status">正在解码图片</div>
          ) : displayedText !== null && isMarkdown(request.path) && markdownView ? (
            <article className={styles.markdownPreview}><SafeMarkdown {...(onOpenLink === undefined ? {} : { onOpenLink })} source={displayedText} /></article>
          ) : displayedText !== null ? (
            <TextSource column={activeLine === request.line ? request.column ?? null : null} endLine={activeEndLine} line={activeLine} matchingLines={matchingLines} query={search} text={displayedText} wrap={wrap} />
          ) : null}
        </main>
      </section>
    </div>
  );
}

type DecodedPreview =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "image"; readonly blob: Blob }
  | { readonly type: "binary" | "tooLarge" };

function decodePreview(path: string, dataBase64: string): DecodedPreview {
  const size = decodedSize(dataBase64);
  if (size > MAX_PREVIEW_BYTES) return { type: "tooLarge" };
  const extension = path.split(".").at(-1)?.toLocaleLowerCase() ?? "";
  const imageMediaType: Readonly<Record<string, string | undefined>> = {
    png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp",
  };
  try {
    if (extension === "svg") {
      return {
        type: "image",
        blob: new Blob([sanitizeSvg(decodeUtf8(dataBase64))], {
          type: "image/svg+xml;charset=utf-8",
        }),
      };
    }
    const mediaType = imageMediaType[extension];
    if (mediaType !== undefined) {
      return { type: "image", blob: new Blob([decodeBytes(dataBase64)], { type: mediaType }) };
    }
    const text = decodeUtf8(dataBase64);
    return text.includes("\0") ? { type: "binary" } : { type: "text", text };
  } catch {
    return { type: "binary" };
  }
}

function TextSource({ column, endLine, line, matchingLines, query, text, wrap }: { readonly column: number | null; readonly endLine: number | null; readonly line: number | null; readonly matchingLines: ReadonlySet<number>; readonly query: string; readonly text: string; readonly wrap: boolean }) {
  return <ol className={styles.source} data-wrapped={wrap}>{text.split(/\r?\n/u).map((value, index) => {
    const lineNumber = index + 1;
    const highlighted = line !== null && lineNumber >= line && lineNumber <= (endLine ?? line);
    return <li data-highlighted={highlighted} id={`preview-line-${lineNumber}`} key={lineNumber}><code>{matchingLines.has(lineNumber) ? highlightQuery(value, query) : value}{line === lineNumber && column !== null ? <span className={styles.columnHint}> · 列 {column}</span> : null}</code></li>;
  })}</ol>;
}

function DiffView({ diff, mode }: { readonly diff: string; readonly mode: "unified" | "split" }) {
  const lines = diff.replace(/\r\n?/gu, "\n").split("\n");
  if (mode === "unified") {
    return <pre className={styles.unifiedDiff}>{lines.map((line, index) => <span data-kind={diffLineKind(line)} key={index}>{line || " "}</span>)}</pre>;
  }
  const rows = splitDiffRows(lines);
  return <div className={styles.splitDiff} role="table" aria-label="左右差异对照">{rows.map((row, index) => <div className={styles.diffRow} key={index} role="row"><code data-kind={row.leftKind} role="cell">{row.left || " "}</code><code data-kind={row.rightKind} role="cell">{row.right || " "}</code></div>)}</div>;
}

function splitDiffRows(lines: readonly string[]): readonly { left: string; right: string; leftKind: string; rightKind: string }[] {
  const rows: { left: string; right: string; leftKind: string; rightKind: string }[] = [];
  let removed: string[] = [];
  let added: string[] = [];
  const flush = () => {
    const count = Math.max(removed.length, added.length);
    for (let index = 0; index < count; index += 1) {
      rows.push({ left: removed[index] ?? "", right: added[index] ?? "", leftKind: "remove", rightKind: "add" });
    }
    removed = [];
    added = [];
  };
  for (const line of lines) {
    if (line.startsWith("-") && !line.startsWith("---")) { removed.push(line.slice(1)); continue; }
    if (line.startsWith("+") && !line.startsWith("+++")) { added.push(line.slice(1)); continue; }
    flush();
    const kind = diffLineKind(line);
    rows.push({ left: line, right: line, leftKind: kind, rightKind: kind });
  }
  flush();
  return rows;
}

function diffLineKind(line: string): string {
  if (line.startsWith("+") && !line.startsWith("+++")) return "add";
  if (line.startsWith("-") && !line.startsWith("---")) return "remove";
  if (line.startsWith("@@")) return "hunk";
  if (line.startsWith("diff ") || line.startsWith("---") || line.startsWith("+++")) return "meta";
  return "context";
}

function highlightQuery(value: string, query: string): React.ReactNode {
  if (query.length === 0) return value;
  const index = value.toLocaleLowerCase().indexOf(query.toLocaleLowerCase());
  return index < 0 ? value : <>{value.slice(0, index)}<mark>{value.slice(index, index + query.length)}</mark>{value.slice(index + query.length)}</>;
}

function decodeUtf8(dataBase64: string): string {
  return new TextDecoder("utf-8", { fatal: true }).decode(decodeBytes(dataBase64));
}

function decodeBytes(dataBase64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(dataBase64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function decodedSize(dataBase64: string): number {
  const padding = dataBase64.endsWith("==") ? 2 : dataBase64.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor(dataBase64.length * 3 / 4) - padding);
}

function fileName(path: string): string { return path.split(/[\\/]/u).at(-1) || "远程文件"; }
function relativeRemotePath(path: string, workspacePath?: string | null): string {
  if (workspacePath === undefined || workspacePath === null) return path;
  const root = workspacePath.replace(/\/+$/u, "");
  return path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path;
}
function languageForPath(path: string): string {
  const extension = path.split(".").at(-1)?.toLocaleLowerCase() ?? "";
  const languages: Readonly<Record<string, string>> = {
    bash: "Shell", c: "C", cc: "C++", cpp: "C++", css: "CSS", go: "Go",
    h: "C/C++", hpp: "C++", html: "HTML", java: "Java", js: "JavaScript",
    json: "JSON", jsonc: "JSONC", jsx: "JavaScript JSX", kt: "Kotlin",
    md: "Markdown", markdown: "Markdown", py: "Python", rb: "Ruby", rs: "Rust",
    sh: "Shell", sql: "SQL", swift: "Swift", toml: "TOML", ts: "TypeScript",
    tsx: "TypeScript JSX", txt: "纯文本", xml: "XML", yaml: "YAML", yml: "YAML",
  };
  return languages[extension] ?? (extension.length === 0 ? "纯文本" : extension.toLocaleUpperCase());
}
function isMarkdown(path: string): boolean { return /\.(?:md|markdown|mdx)$/iu.test(path); }
function isJson(path: string): boolean { return /\.(?:json|jsonc)$/iu.test(path); }
function kindLabel(type: DecodedPreview["type"]): string { return type === "text" ? "文本" : type === "image" ? "图片" : type === "tooLarge" ? "大文件" : "二进制"; }
function lineEnding(text: string): string { return text.includes("\r\n") ? "CRLF" : "LF"; }
function formatBytes(size: number): string { return size < 1024 ? `${size} B` : size < 1024 * 1024 ? `${(size / 1024).toFixed(1)} KiB` : `${(size / (1024 * 1024)).toFixed(1)} MiB`; }
