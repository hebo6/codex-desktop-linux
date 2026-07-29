import {
  useEffect,
  useRef,
  useState,
} from "react";

import type { FileClient } from "../appServer";
import { prepareHtmlPreview } from "../content/htmlPreview";
import type { BlobUrlFactory } from "../content/useBlobUrl";
import styles from "./FilePreviewDialog.module.css";

export type HtmlPreviewState =
  | { readonly phase: "idle" | "loading" | "error" }
  | {
      readonly blockedResourceCount: number;
      readonly phase: "ready";
      readonly url: string;
    };

interface HtmlPreviewSnapshot {
  readonly blobUrlFactory: BlobUrlFactory;
  readonly client: FileClient;
  readonly documentPath: string;
  readonly source: string;
  readonly state: HtmlPreviewState;
  readonly workspacePath: string | null;
}

export function useHtmlPreview({
  active,
  blobUrlFactory,
  client,
  documentPath,
  source,
  workspacePath,
}: {
  readonly active: boolean;
  readonly blobUrlFactory: BlobUrlFactory;
  readonly client: FileClient | null;
  readonly documentPath: string | null;
  readonly source: string | null;
  readonly workspacePath: string | null;
}): HtmlPreviewState {
  const [snapshot, setSnapshot] = useState<HtmlPreviewSnapshot | null>(null);

  useEffect(() => {
    if (
      !active ||
      documentPath === null ||
      source === null ||
      client === null
    ) {
      return;
    }
    let disposed = false;
    const urls = new Set<string>();
    const releaseUrls = () => {
      for (const url of urls) {
        blobUrlFactory.revoke(url);
      }
      urls.clear();
    };
    const createBlobUrl = (blob: Blob) => {
      const url = blobUrlFactory.create(blob);
      if (disposed) {
        blobUrlFactory.revoke(url);
      } else {
        urls.add(url);
      }
      return url;
    };
    const updateState = (state: HtmlPreviewState) => {
      setSnapshot({
        blobUrlFactory,
        client,
        documentPath,
        source,
        state,
        workspacePath,
      });
    };
    updateState({ phase: "loading" });
    void prepareHtmlPreview({
      createBlobUrl,
      documentPath,
      loadFile: async (path) => {
        const metadata = await client.getMetadata(path).result;
        if (!metadata.isFile || metadata.isSymlink) {
          return {
            dataBase64: "",
            isFile: metadata.isFile,
            isSymlink: metadata.isSymlink,
          };
        }
        const response = await client.readFile(path).result;
        return {
          dataBase64: response.dataBase64,
          isFile: metadata.isFile,
          isSymlink: metadata.isSymlink,
        };
      },
      source,
      workspacePath,
    }).then(
      (prepared) => {
        if (disposed) {
          releaseUrls();
          return;
        }
        const url = createBlobUrl(new Blob(
          [prepared.html],
          { type: "text/html;charset=utf-8" },
        ));
        updateState({
          blockedResourceCount: prepared.blockedResourceCount,
          phase: "ready",
          url,
        });
      },
      () => {
        releaseUrls();
        if (!disposed) {
          updateState({ phase: "error" });
        }
      },
    );
    return () => {
      disposed = true;
      releaseUrls();
    };
  }, [
    active,
    blobUrlFactory,
    client,
    documentPath,
    source,
    workspacePath,
  ]);

  if (
    !active ||
    documentPath === null ||
    source === null ||
    client === null
  ) {
    return { phase: "idle" };
  }
  return snapshot !== null &&
    snapshot.blobUrlFactory === blobUrlFactory &&
    snapshot.client === client &&
    snapshot.documentPath === documentPath &&
    snapshot.source === source &&
    snapshot.workspacePath === workspacePath
      ? snapshot.state
      : { phase: "loading" };
}

export function HtmlPreviewFrame({
  name,
  onOpenLink,
  url,
}: {
  readonly name: string;
  readonly onOpenLink?: (link: string) => void;
  readonly url: string;
}) {
  const frameRef = useRef<HTMLIFrameElement>(null);

  useEffect(() => {
    const frame = frameRef.current;
    if (frame === null) {
      return;
    }
    let attachedDocument: Document | null = null;
    const handleClick = (event: Event) => {
      const target = event.target;
      const anchor = target instanceof Element
        ? target.closest<HTMLAnchorElement>("a[data-preview-link]")
        : null;
      const link = anchor?.dataset.previewLink;
      if (link === undefined) {
        return;
      }
      event.preventDefault();
      onOpenLink?.(link);
    };
    const handleSubmit = (event: Event) => {
      event.preventDefault();
    };
    const detach = () => {
      attachedDocument?.removeEventListener("click", handleClick);
      attachedDocument?.removeEventListener("submit", handleSubmit);
      attachedDocument = null;
    };
    const attach = () => {
      detach();
      try {
        attachedDocument = frame.contentDocument;
        attachedDocument?.addEventListener("click", handleClick);
        attachedDocument?.addEventListener("submit", handleSubmit);
      } catch {
        attachedDocument = null;
      }
    };
    frame.addEventListener("load", attach);
    attach();
    return () => {
      frame.removeEventListener("load", attach);
      detach();
    };
  }, [onOpenLink, url]);

  return (
    <iframe
      allow=""
      className={styles.htmlPreview}
      ref={frameRef}
      referrerPolicy="no-referrer"
      sandbox="allow-same-origin"
      src={url}
      title={`${name} HTML 预览`}
    />
  );
}
