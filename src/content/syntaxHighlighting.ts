import type { CSSProperties } from "react";

import type { SyntaxLanguage } from "./syntaxLanguages";

export interface HighlightedToken {
  readonly content: string;
  readonly style: CSSProperties;
}

export type HighlightedLines = readonly (readonly HighlightedToken[])[];

export interface SyntaxHighlighter {
  highlight(source: string, language: SyntaxLanguage): Promise<HighlightedLines>;
}

interface PendingRequest {
  readonly reject: () => void;
  readonly resolve: (value: HighlightedLines) => void;
}

interface WorkerResponse {
  readonly id?: unknown;
  readonly lines?: unknown;
  readonly ok?: unknown;
}

class WorkerSyntaxHighlighter implements SyntaxHighlighter {
  private worker: Worker | null = null;
  private nextRequestId = 0;
  private readonly pending = new Map<number, PendingRequest>();

  highlight(
    source: string,
    language: SyntaxLanguage,
  ): Promise<HighlightedLines> {
    if (this.nextRequestId >= Number.MAX_SAFE_INTEGER) {
      return Promise.reject(
        new RangeError("syntax worker request IDs exhausted"),
      );
    }
    const worker = this.requireWorker();
    if (worker === null) {
      return Promise.reject(new Error("Web Workers are unavailable"));
    }
    const id = ++this.nextRequestId;
    return new Promise<HighlightedLines>((resolve, reject) => {
      this.pending.set(id, { reject, resolve });
      try {
        worker.postMessage({ id, language, source });
      } catch {
        this.pending.delete(id);
        reject();
      }
    });
  }

  private requireWorker(): Worker | null {
    if (this.worker !== null) return this.worker;
    if (typeof Worker === "undefined") return null;
    const worker = new Worker(
      new URL("./syntaxHighlighting.worker.ts", import.meta.url),
      { name: "syntax-highlighting", type: "module" },
    );
    worker.onmessage = ({ data }: MessageEvent<WorkerResponse>) => {
      const id = data.id;
      if (typeof id !== "number" || !Number.isSafeInteger(id)) return;
      const request = this.pending.get(id);
      if (request === undefined) return;
      this.pending.delete(id);
      if (data.ok !== true || !isHighlightedLines(data.lines)) {
        request.reject();
        return;
      }
      request.resolve(data.lines);
    };
    worker.onerror = () => {
      worker.terminate();
      if (this.worker === worker) this.worker = null;
      for (const request of this.pending.values()) request.reject();
      this.pending.clear();
    };
    this.worker = worker;
    return worker;
  }
}

function isHighlightedLines(value: unknown): value is HighlightedLines {
  return Array.isArray(value) && value.every(
    (line: unknown) => Array.isArray(line) && line.every(isHighlightedToken),
  );
}

function isHighlightedToken(value: unknown): value is HighlightedToken {
  if (
    typeof value !== "object" ||
    value === null ||
    !("content" in value) ||
    typeof value.content !== "string" ||
    !("style" in value) ||
    typeof value.style !== "object" ||
    value.style === null ||
    Array.isArray(value.style)
  ) {
    return false;
  }
  return Object.entries(value.style).every(
    ([name, property]) =>
      name.startsWith("--shiki-") && typeof property === "string",
  );
}

export const syntaxHighlighter: SyntaxHighlighter =
  new WorkerSyntaxHighlighter();
