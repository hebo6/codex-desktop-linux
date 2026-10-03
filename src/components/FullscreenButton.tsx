import { getCurrentWindow } from "@tauri-apps/api/window";
import { useCallback, useEffect, useRef, useState } from "react";

import { toggleWindowFullscreen } from "../transport/windowFullscreen";

export function FullscreenButton({ className }: { readonly className?: string | undefined }) {
  const [fullscreen, setFullscreen] = useState<boolean | null>(null);
  const [changing, setChanging] = useState(false);
  const readSequence = useRef(0);
  const refresh = useCallback(async () => {
    const sequence = ++readSequence.current;
    try {
      const value = await getCurrentWindow().isFullscreen();
      if (sequence === readSequence.current) setFullscreen(value);
    } catch (error) {
      console.error("读取全屏状态失败", error);
    }
  }, []);

  useEffect(() => {
    const unlisten = getCurrentWindow().onResized(() => void refresh());
    void refresh();
    return () => {
      readSequence.current += 1;
      void unlisten.then((dispose) => dispose());
    };
  }, [refresh]);

  const label = fullscreen ? "退出全屏" : "进入全屏";
  return (
    <button
      aria-label={label}
      aria-keyshortcuts="F11"
      className={className}
      disabled={fullscreen === null || changing}
      onClick={async () => {
        setChanging(true);
        try {
          await toggleWindowFullscreen();
          await refresh();
        } finally {
          setChanging(false);
        }
      }}
      title={`${label}（F11）`}
      type="button"
    >
      <svg aria-hidden="true" height="18" viewBox="0 0 24 24" width="18">
        <path d={fullscreen
          ? "m21 3-7 7m0-7v7h7M3 21l7-7m-7 0h7v7"
          : "M14 3h7v7m0-7-7 7M10 21H3v-7m0 7 7-7"} />
      </svg>
    </button>
  );
}
