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
  return result.map(parseClipboardFile);
}

function parseClipboardFile(value: unknown): ClipboardFileResult {
  if (!isRecord(value)) {
    throw new TypeError("系统剪贴板返回了无效文件");
  }
  const { dataBase64, error, name, size } = value;
  if (
    typeof name !== "string"
    || name.length === 0
    || !Number.isSafeInteger(size)
    || (size as number) < 0
    || (dataBase64 !== null && typeof dataBase64 !== "string")
    || (error !== null && typeof error !== "string")
    || (dataBase64 === null) === (error === null)
  ) {
    throw new TypeError("系统剪贴板返回了无效文件");
  }
  if (dataBase64 === null) {
    return { name, size: size as number, file: null, error: error as string };
  }

  const bytes = decodeBase64(dataBase64);
  if (bytes.byteLength !== size) {
    throw new TypeError("系统剪贴板返回的文件大小不一致");
  }
  return {
    name,
    size: size as number,
    file: new File([bytes], name),
    error: null,
  };
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
