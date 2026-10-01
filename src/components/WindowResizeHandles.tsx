import { useEffect, useState } from "react";

import { getCurrentWindow } from "@tauri-apps/api/window";

import styles from "./WindowResizeHandles.module.css";

type ResizeDirection =
  | "North"
  | "South"
  | "East"
  | "West"
  | "NorthEast"
  | "NorthWest"
  | "SouthEast"
  | "SouthWest";

const handles: { className: string | undefined; direction: ResizeDirection }[] = [
  { className: styles.edgeN, direction: "North" },
  { className: styles.edgeS, direction: "South" },
  { className: styles.edgeW, direction: "West" },
  { className: styles.edgeE, direction: "East" },
  { className: styles.cornerNW, direction: "NorthWest" },
  { className: styles.cornerNE, direction: "NorthEast" },
  { className: styles.cornerSW, direction: "SouthWest" },
  { className: styles.cornerSE, direction: "SouthEast" },
];

/**
 * Invisible resize handles rendered at the window edges and corners.
 * Only visible (pointer-interactive) outside maximized and fullscreen modes.
 */
export function WindowResizeHandles() {
  const [resizable, setResizable] = useState(false);

  useEffect(() => {
    const appWindow = getCurrentWindow();
    const updateResizable = () => {
      void Promise.all([appWindow.isMaximized(), appWindow.isFullscreen()])
        .then(([maximized, fullscreen]) => setResizable(!maximized && !fullscreen));
    };
    updateResizable();
    const unlisten = appWindow.onResized(updateResizable);
    return () => {
      void unlisten.then((fn) => fn());
    };
  }, []);

  if (!resizable) return null;

  const appWindow = getCurrentWindow();

  return (
    <div aria-hidden="true" className={styles.resizeHandles}>
      {handles.map(({ className, direction }) => (
        <div
          className={`${styles.edge} ${className}`}
          key={direction}
          onMouseDown={() => void appWindow.startResizeDragging(direction)}
        />
      ))}
    </div>
  );
}
