import type { JsonFormatResult } from "./contentProcessingCore";

export interface ContentProcessor {
  formatJson(source: string): Promise<JsonFormatResult>;
  findMatchingLines(
    source: string,
    query: string,
  ): Promise<Uint32Array<ArrayBuffer>>;
}

interface PendingRequest {
  readonly reject: () => void;
  readonly resolve: (value: unknown) => void;
}

interface WorkerResponse {
  readonly id?: unknown;
  readonly ok?: unknown;
  readonly result?: unknown;
  readonly matches?: unknown;
}

class WorkerContentProcessor implements ContentProcessor {
  private worker: Worker | null = null;
  private nextRequestId = 0;
  private readonly pending = new Map<number, PendingRequest>();

  formatJson(source: string): Promise<JsonFormatResult> {
    return this.request({ type: "formatJson", source }).then((value) => {
      if (
        typeof value !== "object" ||
        value === null ||
        !("formatted" in value) ||
        typeof value.formatted !== "boolean" ||
        !("text" in value) ||
        typeof value.text !== "string"
      ) {
        throw new TypeError("invalid content worker response");
      }
      return { formatted: value.formatted, text: value.text };
    });
  }

  findMatchingLines(
    source: string,
    query: string,
  ): Promise<Uint32Array<ArrayBuffer>> {
    return this.request({ type: "findLines", source, query }).then((value) => {
      if (!(value instanceof Uint32Array)) {
        throw new TypeError("invalid content worker response");
      }
      return value as Uint32Array<ArrayBuffer>;
    });
  }

  private request(
    request:
      | { readonly type: "formatJson"; readonly source: string }
      | {
          readonly type: "findLines";
          readonly source: string;
          readonly query: string;
        },
  ): Promise<unknown> {
    if (this.nextRequestId >= Number.MAX_SAFE_INTEGER) {
      return Promise.reject(new RangeError("content worker request IDs exhausted"));
    }
    const worker = this.requireWorker();
    const id = ++this.nextRequestId;
    const result = new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { reject, resolve });
    });
    worker.postMessage({ id, ...request });
    return result;
  }

  private requireWorker(): Worker {
    if (this.worker !== null) return this.worker;
    const worker = new Worker(
      new URL("./contentProcessing.worker.ts", import.meta.url),
      { name: "content-processing", type: "module" },
    );
    worker.onmessage = ({ data }: MessageEvent<WorkerResponse>) => {
      const id = data.id;
      if (typeof id !== "number" || !Number.isSafeInteger(id)) return;
      const request = this.pending.get(id);
      if (request === undefined) return;
      this.pending.delete(id);
      if (data.ok !== true) {
        request.reject();
      } else if (data.matches !== undefined) {
        request.resolve(data.matches);
      } else {
        request.resolve(data.result);
      }
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

export const contentProcessor: ContentProcessor = new WorkerContentProcessor();
