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
import {
  decodeBase64Bytes,
  decodedBase64Size,
  parseDataImageUrl,
} from "../content/dataImage";
import { sanitizeSvg } from "../content/sanitizeSvg";
import {
  syntaxHighlighter as sharedSyntaxHighlighter,
  type HighlightedLines,
  type HighlightedToken,
  type SyntaxHighlighter,
} from "../content/syntaxHighlighting";
import {
  sourceLanguageForPath,
  type SyntaxLanguage,
} from "../content/syntaxLanguages";
import {
  browserBlobUrls,
  useBlobUrl,
  type BlobUrlFactory,
} from "../content/useBlobUrl";
import { saveRemoteFile } from "../transport/systemDialog";
import {
  HtmlPreviewFrame,
  useHtmlPreview,
} from "./HtmlPreviewFrame";
import { useModalLayer } from "./modalStack";
import { SafeMarkdown } from "./SafeMarkdown";
import styles from "./FilePreviewDialog.module.css";

const MAX_PREVIEW_BYTES = 16 * 1024 * 1024;

export interface RemoteFilePreviewRequest {
  readonly type?: "file";
  readonly path: string;
  readonly line?: number | null;
  readonly endLine?: number | null;
  readonly column?: number | null;
  readonly diff?: string | null;
}

export interface DataImagePreviewRequest {
  readonly type: "dataImage";
  readonly dataUrl: string;
  readonly name: string;
}

export type FilePreviewRequest =
  | RemoteFilePreviewRequest
  | DataImagePreviewRequest;

interface LoadedFile {
  readonly dataBase64: string;
  readonly modifiedAtMs: number;
}

type FileViewMode = "preview" | "source";

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
  syntaxHighlighter = sharedSyntaxHighlighter,
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
  readonly syntaxHighlighter?: SyntaxHighlighter;
}) {
  const titleId = useId();
  const dialogRef = useRef<HTMLElement>(null);
  const [loaded, setLoaded] = useState<LoadedFile | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [wrap, setWrap] = useState(defaultWrap);
  const [search, setSearch] = useState("");
  const [viewSelection, setViewSelection] = useState<{
    readonly mode: FileViewMode;
    readonly request: FilePreviewRequest | null;
  }>(() => ({
    mode: defaultFileView(request?.type === "dataImage" ? null : request),
    request,
  }));
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
  const [highlightedSource, setHighlightedSource] = useState<{
    readonly language: SyntaxLanguage;
    readonly lines: HighlightedLines;
    readonly source: string;
  } | null>(null);
  const fileRequest = request?.type === "dataImage" ? null : request;
  const dataImageRequest = request?.type === "dataImage" ? request : null;
  const previewPath = dataImageRequest?.name ?? fileRequest?.path ?? null;
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
    setActiveLine(fileRequest?.line ?? null);
    setActiveEndLine(fileRequest?.endLine ?? null);
    setJumpLine(fileRequest?.line === undefined || fileRequest.line === null
      ? ""
      : String(fileRequest.line));
    setJumpError(null);
    setDiffMode("unified");
    setSaveStatus(null);
    if (request === null) {
      setLoading(false);
      return;
    }
    if (dataImageRequest !== null) {
      const parsed = parseDataImageUrl(dataImageRequest.dataUrl);
      if (parsed === null) {
        setLoading(false);
        setError("此用户消息不包含可预览的图片数据");
      } else {
        setLoaded({ dataBase64: parsed.dataBase64, modifiedAtMs: 0 });
        setLoading(false);
      }
      return;
    }
    if (fileRequest === null) {
      setLoading(false);
      setError("缺少文件预览请求");
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
      client.getMetadata(fileRequest.path).result,
      client.readFile(fileRequest.path).result,
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
  }, [attempt, client, dataImageRequest, defaultWrap, fileRequest, request]);

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
    () => previewPath === null || loaded === null
      ? null
      : decodePreview(previewPath, loaded.dataBase64),
    [loaded, previewPath],
  );
  const sourceText = decoded?.type === "text"
    ? decoded.text
    : decoded?.type === "image"
      ? decoded.sourceText ?? null
      : null;
  const availableViews = fileRequest === null
    ? (["preview"] as const)
    : fileViewsForPath(fileRequest.path);
  const selectedView = viewSelection.request === request
    ? viewSelection.mode
    : defaultFileView(fileRequest);
  const activeView = availableViews.includes(selectedView)
    ? selectedView
    : availableViews[0] ?? "source";
  const imageUrl = useBlobUrl(
    activeView === "preview" && decoded?.type === "image"
      ? decoded.blob
      : null,
    blobUrlFactory,
  );

  useEffect(() => {
    setFormattedText(null);
    setFormattingJson(false);
    if (sourceText === null) return;
    if (fileRequest === null || !isJson(fileRequest.path)) {
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
  }, [contentProcessor, fileRequest, sourceText]);

  const displayedText = activeView === "preview" &&
    fileRequest !== null &&
    isJson(fileRequest.path)
      ? formattedText ?? sourceText
      : sourceText;
  const sourceLanguage =
    previewPath === null ? null : sourceLanguageForPath(previewPath);
  const htmlPreview = useHtmlPreview({
    active: activeView === "preview" &&
      fileRequest !== null &&
      isHtml(fileRequest.path),
    blobUrlFactory,
    client,
    documentPath: fileRequest?.path ?? null,
    source: sourceText,
    workspacePath: workspacePath ?? null,
  });

  useEffect(() => {
    setHighlightedSource(null);
    if (
      displayedText === null ||
      sourceLanguage === null ||
      (
        activeView === "preview" &&
        (fileRequest === null || !isJson(fileRequest.path))
      ) ||
      (fileRequest?.diff !== undefined && fileRequest.diff !== null)
    ) {
      return;
    }
    let disposed = false;
    const lineCount = displayedText.split(/\r?\n/u).length;
    void Promise.resolve()
      .then(() => syntaxHighlighter.highlight(displayedText, sourceLanguage.id))
      .then(
        (lines) => {
          if (!disposed && lines.length === lineCount) {
            setHighlightedSource({
              language: sourceLanguage.id,
              lines,
              source: displayedText,
            });
          }
        },
        () => {},
      );
    return () => {
      disposed = true;
    };
  }, [
    activeView,
    displayedText,
    fileRequest,
    sourceLanguage,
    syntaxHighlighter,
  ]);

  useEffect(() => {
    setMatchingLines(new Set());
    setSearchingText(false);
    if (
      activeView !== "source" ||
      displayedText === null ||
      search.length === 0
    ) {
      return;
    }
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
  }, [activeView, contentProcessor, displayedText, search]);

  useEffect(() => {
    if (
      activeView !== "source" ||
      activeLine === null ||
      sourceText === null
    ) {
      return;
    }
    const target = document.getElementById(`preview-line-${activeLine}`);
    if (target !== null && typeof target.scrollIntoView === "function") {
      target.scrollIntoView({ block: "center" });
    }
  }, [activeLine, activeView, displayedText, sourceText]);

  useEffect(() => {
    if (activeView !== "preview" || decoded?.type !== "image") return;
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
  }, [activeView, decoded?.type, imageFit, imageSize, rotation, zoom]);

  if (request === null) {
    return null;
  }
  const name = dataImageRequest?.name ?? fileName(fileRequest?.path ?? "");
  const relativePath = dataImageRequest === null
    ? relativeRemotePath(fileRequest?.path ?? "", workspacePath)
    : "用户消息中的图片";
  const language = languageForPath(previewPath ?? "");
  const highlightedLines =
    highlightedSource?.source === displayedText &&
    highlightedSource.language === sourceLanguage?.id
      ? highlightedSource.lines
      : null;
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
    const size = decodedBase64Size(loaded.dataBase64);
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
          <div>
            <h2 id={titleId}>{name}</h2>
            <p>{dataImageRequest === null ? `${serverName} · ${relativePath}` : relativePath}</p>
          </div>
          <div className={styles.headerActions}>
            <button disabled={loaded === null || saving} onClick={() => void save()} type="button">{saving ? "正在保存" : "另存为"}</button>
            <button aria-label="关闭文件预览" onClick={onClose} type="button">×</button>
          </div>
        </header>
        {saveStatus === null ? null : <div className={styles.status} role="status">{saveStatus}</div>}
        <div className={styles.meta}>
          <span>{decoded === null ? "正在识别" : kindLabel(decoded.type)}</span>
          <span>{loaded === null ? "大小未知" : formatBytes(decodedBase64Size(loaded.dataBase64))}</span>
          {sourceText === null ? null : <><span>{language}</span><span>UTF-8</span><span>{lineEnding(sourceText)}</span></>}
          {loaded !== null && loaded.modifiedAtMs > 0 ? <span>{new Date(loaded.modifiedAtMs).toLocaleString()}</span> : null}
        </div>
        <div className={styles.toolbar}>
          {fileRequest?.diff !== undefined && fileRequest.diff !== null ? (
            <>
              <button aria-pressed={diffMode === "unified"} onClick={() => setDiffMode("unified")} type="button">统一差异</button>
              <button aria-pressed={diffMode === "split"} onClick={() => setDiffMode("split")} type="button">左右对照</button>
            </>
          ) : (
            <>
              {availableViews.length > 1 ? (
                <div aria-label="文件视图" className={styles.viewSwitch} role="group">
                  {availableViews.map((mode) => (
                    <button
                      aria-pressed={activeView === mode}
                      key={mode}
                      onClick={() => setViewSelection({ mode, request })}
                      type="button"
                    >
                      {mode === "preview" ? "预览" : "源码"}
                    </button>
                  ))}
                </div>
              ) : null}
              {activeView === "source" && sourceText !== null ? (
                <>
                  <input aria-label="在文件中查找" onChange={(event) => setSearch(event.target.value)} placeholder="查找" type="search" value={search} />
                  {search.length === 0 ? null : <span role="status">{searchingText ? "正在搜索" : `${matchingLines.size} 行匹配`}</span>}
                  <label className={styles.jumpLine}><span className={styles.srOnly}>跳转到行</span><input aria-label="跳转到行" min={1} onChange={(event) => setJumpLine(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") jumpToLine(); }} placeholder="行号" type="number" value={jumpLine} /><button onClick={jumpToLine} type="button">跳转</button></label>
                  {jumpError === null ? null : <span className={styles.inlineError} role="alert">{jumpError}</span>}
                  <button onClick={() => void navigator.clipboard.writeText(window.getSelection()?.toString() ?? "")} type="button">复制选区</button>
                  <button aria-pressed={wrap} onClick={() => setWrap((value) => !value)} type="button">{wrap ? "不折行" : "折行"}</button>
                </>
              ) : null}
              {activeView === "preview" && fileRequest !== null && isJson(fileRequest.path) && formattingJson ? <span role="status">正在格式化 JSON</span> : null}
              {activeView === "preview" && htmlPreview.phase === "ready" && htmlPreview.blockedResourceCount > 0 ? <span role="status">{htmlPreview.blockedResourceCount} 个外部或不支持的资源未加载</span> : null}
              {activeView === "preview" && decoded?.type === "image" ? (
                <>
                  <button onClick={() => updateZoom(zoom - 0.2)} type="button">缩小</button>
                  <button onClick={() => updateZoom(zoom + 0.2)} type="button">放大</button>
                  <button aria-pressed={imageFit} onClick={() => { setImageFit(true); setZoom(1); setRotation(0); setImagePan({ x: 0, y: 0 }); }} type="button">适应窗口</button>
                  <button aria-pressed={!imageFit} onClick={() => { setImageFit(false); setZoom(1); setImagePan({ x: 0, y: 0 }); }} type="button">原始尺寸</button>
                  <button onClick={() => { setRotation((value) => (value + 90) % 360); setImagePan({ x: 0, y: 0 }); }} type="button">旋转</button>
                  <span>{Math.round(zoom * 100)}%</span>
                </>
              ) : null}
            </>
          )}
          {fileRequest === null
            ? null
            : <button onClick={() => void navigator.clipboard.writeText(fileRequest.path)} type="button">复制路径</button>}
        </div>
        <main className={styles.content}>
          {fileRequest?.diff !== undefined && fileRequest.diff !== null ? (
            <DiffView diff={fileRequest.diff} mode={diffMode} />
          ) : loading ? <div className={styles.placeholder} role="status">正在读取 {name}</div> : error !== null ? (
            <div className={styles.placeholder} role="alert"><strong>{error}</strong><button onClick={() => setAttempt((value) => value + 1)} type="button">重试</button></div>
          ) : decoded?.type === "tooLarge" ? (
            <div className={styles.placeholder}><strong>文件超过 16 MiB 预览上限</strong><span>仍可使用另存为保存完整内容</span></div>
          ) : decoded?.type === "binary" ? (
            <div className={styles.placeholder}><strong>此文件不是有效的 UTF-8 文本或支持的图片</strong><span>为避免在 WebView 中执行未知内容，仅提供另存为</span></div>
          ) : activeView === "preview" && fileRequest !== null && isHtml(fileRequest.path) && htmlPreview.phase === "loading" ? (
            <div className={styles.placeholder} role="status">正在准备隔离的 HTML 预览</div>
          ) : activeView === "preview" && fileRequest !== null && isHtml(fileRequest.path) && htmlPreview.phase === "error" ? (
            <div className={styles.placeholder} role="alert"><strong>无法安全处理此 HTML 文件</strong><span>仍可切换到源码视图查看原始内容</span></div>
          ) : activeView === "preview" && fileRequest !== null && isHtml(fileRequest.path) && htmlPreview.phase === "ready" ? (
            <HtmlPreviewFrame name={name} onOpenLink={onOpenLink} url={htmlPreview.url} />
          ) : activeView === "preview" && displayedText !== null && fileRequest !== null && isMarkdown(fileRequest.path) ? (
            <article className={styles.markdownPreview}><SafeMarkdown {...(onOpenLink === undefined ? {} : { onOpenLink })} source={displayedText} /></article>
          ) : activeView === "preview" && displayedText !== null && fileRequest !== null && isJson(fileRequest.path) ? (
            <StructuredTextPreview highlightedLines={highlightedLines} text={displayedText} />
          ) : activeView === "preview" && decoded?.type === "image" && imageUrl !== null ? (
            <div className={styles.imageViewport} data-pannable={canPanImage} onPointerCancel={endPan} onPointerDown={beginPan} onPointerMove={movePan} onPointerUp={endPan} onWheel={zoomAtPointer} ref={imageViewportRef}><img alt={name} data-fit={imageFit} decoding="async" draggable={false} onLoad={(event) => setImageSize({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })} src={imageUrl} style={{ transform: `translate(${imagePan.x}px, ${imagePan.y}px) scale(${zoom}) rotate(${rotation}deg)` }} /></div>
          ) : activeView === "preview" && decoded?.type === "image" ? (
            <div className={styles.placeholder} role="status">正在解码图片</div>
          ) : activeView === "source" && displayedText !== null ? (
            <TextSource column={activeLine === fileRequest?.line ? fileRequest?.column ?? null : null} endLine={activeEndLine} highlightedLines={highlightedLines} line={activeLine} matchingLines={matchingLines} query={search} text={displayedText} wrap={wrap} />
          ) : null}
        </main>
      </section>
    </div>
  );
}

type DecodedPreview =
  | { readonly type: "text"; readonly text: string }
  | {
      readonly type: "image";
      readonly blob: Blob;
      readonly sourceText?: string;
    }
  | { readonly type: "binary" | "tooLarge" };

function decodePreview(path: string, dataBase64: string): DecodedPreview {
  const size = decodedBase64Size(dataBase64);
  if (size > MAX_PREVIEW_BYTES) return { type: "tooLarge" };
  const extension = path.split(".").at(-1)?.toLocaleLowerCase() ?? "";
  const imageMediaType: Readonly<Record<string, string | undefined>> = {
    png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp",
  };
  try {
    if (extension === "svg") {
      const sourceText = decodeUtf8(dataBase64);
      return {
        type: "image",
        blob: new Blob([sanitizeSvg(sourceText)], {
          type: "image/svg+xml;charset=utf-8",
        }),
        sourceText,
      };
    }
    const mediaType = imageMediaType[extension];
    if (mediaType !== undefined) {
      return { type: "image", blob: new Blob([decodeBase64Bytes(dataBase64)], { type: mediaType }) };
    }
    const text = decodeUtf8(dataBase64);
    return text.includes("\0") ? { type: "binary" } : { type: "text", text };
  } catch {
    return { type: "binary" };
  }
}

function StructuredTextPreview({
  highlightedLines,
  text,
}: {
  readonly highlightedLines: HighlightedLines | null;
  readonly text: string;
}) {
  const lines = text.split(/\r?\n/u);
  return (
    <pre className={styles.structuredPreview}>
      <code>
        {lines.map((line, index) => (
          <span key={index}>
            {highlightLine(line, highlightedLines?.[index], "")}
            {index === lines.length - 1 ? null : "\n"}
          </span>
        ))}
      </code>
    </pre>
  );
}

function TextSource({ column, endLine, highlightedLines, line, matchingLines, query, text, wrap }: { readonly column: number | null; readonly endLine: number | null; readonly highlightedLines: HighlightedLines | null; readonly line: number | null; readonly matchingLines: ReadonlySet<number>; readonly query: string; readonly text: string; readonly wrap: boolean }) {
  return <ol className={styles.source} data-wrapped={wrap}>{text.split(/\r?\n/u).map((value, index) => {
    const lineNumber = index + 1;
    const highlighted = line !== null && lineNumber >= line && lineNumber <= (endLine ?? line);
    return <li data-highlighted={highlighted} id={`preview-line-${lineNumber}`} key={lineNumber}><code>{highlightLine(value, highlightedLines?.[index], matchingLines.has(lineNumber) ? query : "")}{line === lineNumber && column !== null ? <span className={styles.columnHint}> · 列 {column}</span> : null}</code></li>;
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

function highlightLine(
  value: string,
  tokens: readonly HighlightedToken[] | undefined,
  query: string,
): React.ReactNode {
  if (
    tokens === undefined ||
    tokens.map((token) => token.content).join("") !== value
  ) {
    return highlightQuery(value, query);
  }
  const matchStart = query.length === 0
    ? -1
    : value.toLocaleLowerCase().indexOf(query.toLocaleLowerCase());
  const matchEnd = matchStart + query.length;
  let offset = 0;
  return tokens.map((token, index) => {
    const tokenStart = offset;
    offset += token.content.length;
    const matchStartsBeforeTokenEnd = matchStart < offset;
    const matchEndsAfterTokenStart = matchEnd > tokenStart;
    const content = matchStart >= 0 &&
      matchStartsBeforeTokenEnd &&
      matchEndsAfterTokenStart
      ? highlightTokenQuery(token.content, tokenStart, matchStart, matchEnd)
      : token.content;
    return <span key={`${tokenStart}-${index}`} style={token.style}>{content}</span>;
  });
}

function highlightTokenQuery(
  content: string,
  tokenStart: number,
  matchStart: number,
  matchEnd: number,
): React.ReactNode {
  const start = Math.max(0, matchStart - tokenStart);
  const end = Math.min(content.length, matchEnd - tokenStart);
  return <>{content.slice(0, start)}<mark>{content.slice(start, end)}</mark>{content.slice(end)}</>;
}

function decodeUtf8(dataBase64: string): string {
  return new TextDecoder("utf-8", { fatal: true }).decode(
    decodeBase64Bytes(dataBase64),
  );
}

function fileName(path: string): string { return path.split(/[\\/]/u).at(-1) || "远程文件"; }
function relativeRemotePath(path: string, workspacePath?: string | null): string {
  if (workspacePath === undefined || workspacePath === null) return path;
  const root = workspacePath.replace(/\/+$/u, "");
  return path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path;
}
function languageForPath(path: string): string {
  const sourceLanguage = sourceLanguageForPath(path);
  if (sourceLanguage !== null) return sourceLanguage.label;
  const extension = path.split(".").at(-1)?.toLocaleLowerCase() ?? "";
  return extension.length === 0 || extension === "txt"
    ? "纯文本"
    : extension.toLocaleUpperCase();
}
function isMarkdown(path: string): boolean { return /\.(?:md|markdown|mdx)$/iu.test(path); }
function isHtml(path: string): boolean { return /\.(?:htm|html)$/iu.test(path); }
function isJson(path: string): boolean { return /\.(?:json|jsonc)$/iu.test(path); }
function isSvg(path: string): boolean { return /\.svg$/iu.test(path); }
function fileViewsForPath(path: string): readonly FileViewMode[] {
  if (isMarkdown(path) || isHtml(path) || isJson(path) || isSvg(path)) {
    return ["preview", "source"];
  }
  return /\.(?:gif|jpe?g|png|webp|pdf)$/iu.test(path)
    ? ["preview"]
    : ["source"];
}
function defaultFileView(
  request: RemoteFilePreviewRequest | null,
): FileViewMode {
  if (
    (request?.line !== undefined && request.line !== null) ||
    (request?.endLine !== undefined && request.endLine !== null) ||
    (request?.column !== undefined && request.column !== null)
  ) {
    return "source";
  }
  return request === null
    ? "preview"
    : fileViewsForPath(request.path)[0] ?? "source";
}
function kindLabel(type: DecodedPreview["type"]): string { return type === "text" ? "文本" : type === "image" ? "图片" : type === "tooLarge" ? "大文件" : "二进制"; }
function lineEnding(text: string): string { return text.includes("\r\n") ? "CRLF" : "LF"; }
function formatBytes(size: number): string { return size < 1024 ? `${size} B` : size < 1024 * 1024 ? `${(size / 1024).toFixed(1)} KiB` : `${(size / (1024 * 1024)).toFixed(1)} MiB`; }
