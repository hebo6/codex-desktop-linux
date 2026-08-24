import { getCurrentWindow } from "@tauri-apps/api/window";

export async function setWindowTitle(title: string): Promise<void> {
  document.title = title;
  await getCurrentWindow().setTitle(title);
}
