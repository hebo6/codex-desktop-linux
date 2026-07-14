import { tauriIpc, type TauriIpc } from "./tauriIpc";

export async function pickLocalDirectory(
  ipc: TauriIpc = tauriIpc,
): Promise<string | null> {
  const result = await ipc.invoke<unknown>("pick_local_directory", {});
  if (result === null) {
    return null;
  }
  if (typeof result !== "string" || !result.startsWith("/")) {
    throw new TypeError("目录选择器返回了无效路径");
  }
  return result;
}

export function openExternalUrl(url: string, ipc: TauriIpc = tauriIpc): Promise<void> {
  return ipc.invoke<void>("open_external_url", { url });
}

export function saveRemoteFile(
  dataBase64: string,
  suggestedName: string,
  allowLarge = false,
  ipc: TauriIpc = tauriIpc,
): Promise<string | null> {
  return ipc.invoke<string | null>("save_remote_file", {
    dataBase64,
    suggestedName,
    allowLarge,
  });
}
