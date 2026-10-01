import { tauriIpc, type TauriIpc } from "./tauriIpc";

export async function readRemoteImage(url: string, ipc: TauriIpc = tauriIpc): Promise<string> {
  const response = await ipc.invoke<unknown>(
    "read_remote_image", { url },
  );
  if (typeof response !== "object" || response === null
    || !("mediaType" in response) || typeof response.mediaType !== "string"
    || !("dataBase64" in response) || typeof response.dataBase64 !== "string") {
    throw new Error("服务器返回了无效的图片数据");
  }
  return `data:${response.mediaType};base64,${response.dataBase64}`;
}
