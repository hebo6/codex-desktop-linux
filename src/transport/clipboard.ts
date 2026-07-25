import { tauriIpc, type TauriIpc } from "./tauriIpc";

export type ClipboardFileResult =
  | {
      readonly name: string;
      readonly size: number;
      readonly file: File;
      readonly error: null;
    }
  | {
      readonly name: string;
      readonly size: number;
      readonly file: null;
      readonly error: string;
    };

export type ClipboardFilesReader = () => Promise<readonly ClipboardFileResult[]>;

export async function readClipboardFiles(
  ipc: TauriIpc = tauriIpc,
): Promise<readonly ClipboardFileResult[]> {
  const result = await ipc.invoke<unknown>("read_clipboard_files", {});
  if (!Array.isArray(result)) {
    throw new TypeError("系统剪贴板返回了无效文件列表");
  }
  return Promise.all(result.map((value) => readClipboardFile(value, ipc)));
}

async function readClipboardFile(
  value: unknown,
  ipc: TauriIpc,
): Promise<ClipboardFileResult> {
  if (!isRecord(value)) {
    throw new TypeError("系统剪贴板返回了无效文件");
  }
  const { error, name, size, token } = value;
  if (
    typeof name !== "string"
    || name.length === 0
    || !Number.isSafeInteger(size)
    || (size as number) < 0
    || (token !== null && (typeof token !== "string" || !isUuid(token)))
    || (error !== null && typeof error !== "string")
    || (token === null) === (error === null)
  ) {
    throw new TypeError("系统剪贴板返回了无效文件");
  }
  if (token === null) {
    return { name, size: size as number, file: null, error: error as string };
  }

  const bytes = new Uint8Array(size as number);
  let offset = 0;
  while (offset < bytes.byteLength || offset === 0) {
    const chunk = parseClipboardFileChunk(
      await ipc.invoke<unknown>("read_clipboard_file_chunk", { token, offset }),
      offset,
      bytes.byteLength,
    );
    bytes.set(chunk.bytes, offset);
    offset = chunk.nextOffset;
    if (chunk.complete) {
      break;
    }
  }
  if (offset !== bytes.byteLength) {
    throw new TypeError("系统剪贴板返回的文件大小不一致");
  }
  return {
    name,
    size: size as number,
    file: new File([bytes], name),
    error: null,
  };
}

function parseClipboardFileChunk(
  value: unknown,
  offset: number,
  fileSize: number,
): {
  readonly bytes: Uint8Array<ArrayBuffer>;
  readonly nextOffset: number;
  readonly complete: boolean;
} {
  if (!isRecord(value)) {
    throw new TypeError("系统剪贴板返回了无效文件分块");
  }
  const { complete, dataBase64, nextOffset } = value;
  if (
    typeof complete !== "boolean"
    || typeof dataBase64 !== "string"
    || !Number.isSafeInteger(nextOffset)
  ) {
    throw new TypeError("系统剪贴板返回了无效文件分块");
  }
  const bytes = decodeBase64(dataBase64);
  if (
    nextOffset !== offset + bytes.byteLength
    || nextOffset > fileSize
    || complete !== (nextOffset === fileSize)
    || (!complete && bytes.byteLength === 0)
  ) {
    throw new TypeError("系统剪贴板返回了无效文件分块");
  }
  return { bytes, nextOffset, complete };
}

function decodeBase64(value: string): Uint8Array<ArrayBuffer> {
  if (!/^(?:[a-z\d+/]{4})*(?:[a-z\d+/]{2}==|[a-z\d+/]{3}=)?$/iu.test(value)) {
    throw new TypeError("系统剪贴板返回了无效文件内容");
  }
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
    .test(value);
}
