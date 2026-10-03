import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect } from "react";

import { toggleWindowFullscreen } from "../transport/windowFullscreen";

export function ApplicationShortcuts() {
  useEffect(() => {
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
        void toggleWindowFullscreen();
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
