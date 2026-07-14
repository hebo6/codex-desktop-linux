import { findMatchingLines, formatJsonContent } from "./contentProcessingCore";

type ContentWorkerRequest =
  | {
      readonly id: number;
      readonly type: "formatJson";
      readonly source: string;
    }
  | {
      readonly id: number;
      readonly type: "findLines";
      readonly source: string;
      readonly query: string;
    };

interface WorkerScope {
  onmessage: ((event: MessageEvent<ContentWorkerRequest>) => void) | null;
  postMessage(message: unknown, transfer?: Transferable[]): void;
}

const workerScope = globalThis as unknown as WorkerScope;

workerScope.onmessage = ({ data }) => {
  try {
    if (data.type === "formatJson") {
      workerScope.postMessage({
        id: data.id,
        ok: true,
        result: formatJsonContent(data.source),
      });
      return;
    }
    const matches = findMatchingLines(data.source, data.query);
    workerScope.postMessage(
      { id: data.id, matches, ok: true },
      [matches.buffer],
    );
  } catch {
    workerScope.postMessage({ id: data.id, ok: false });
  }
};
