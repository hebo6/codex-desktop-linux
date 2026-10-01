import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect } from "react";

export function ApplicationShortcuts() {
  useEffect(() => {
    let fullscreenChanging = false;
    const toggleFullscreen = async () => {
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
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        event.repeat ||
        event.isComposing ||
        event.altKey ||
        event.metaKey
      ) {
        return;
      }

      const key = event.key.toLowerCase();
      if (key === "f11" && !event.ctrlKey && !event.shiftKey) {
        event.preventDefault();
        void toggleFullscreen();
        return;
      }

      if (!event.ctrlKey) return;
      if (key === "q" && !event.shiftKey) {
        event.preventDefault();
        void invoke("quit_application");
      } else if (key === "w" && event.shiftKey) {
        event.preventDefault();
        void getCurrentWindow().close();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  return null;
}
