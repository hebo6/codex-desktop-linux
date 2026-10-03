import { getCurrentWindow } from "@tauri-apps/api/window";

let fullscreenChanging = false;

export async function toggleWindowFullscreen(): Promise<void> {
  if (fullscreenChanging) return;
  fullscreenChanging = true;
  try {
    const appWindow = getCurrentWindow();
    await appWindow.setFullscreen(!await appWindow.isFullscreen());
  } catch (error) {
    console.error("切换全屏失败", error);
  } finally {
    fullscreenChanging = false;
  }
}
