import { useEffect, useState } from "react";

import { getCurrentWindow } from "@tauri-apps/api/window";
import { invoke } from "@tauri-apps/api/core";

import styles from "./WindowControls.module.css";

/**
 * Parse the GNOME button-layout string (e.g. "appmenu:close" or
 * "close,minimize,maximize:") into left and right button lists.
 * Only recognized window control buttons are kept.
 */
function parseButtonLayout(layout: string): {
  left: string[];
  right: string[];
} {
  const [leftRaw = "", rightRaw = ""] = layout.split(":");
  const parse = (raw: string): string[] =>
    raw
      .split(",")
      .map((s) => s.trim())
      .filter(
        (s): s is "minimize" | "maximize" | "close" =>
          s === "minimize" || s === "maximize" || s === "close",
      );
  return { left: parse(leftRaw), right: parse(rightRaw) };
}

type ButtonType = "minimize" | "maximize" | "close";

const MinimizeIcon = () => (
  <svg aria-hidden="true" viewBox="0 0 10 10">
    <line x1="1.5" y1="5" x2="8.5" y2="5" />
  </svg>
);

const MaximizeIcon = ({ maximized }: { maximized: boolean }) =>
  maximized ? (
    <svg aria-hidden="true" viewBox="0 0 10 10">
      <rect x="3" y="1.5" width="5.5" height="5.5" rx="1" />
      <rect x="1.5" y="3" width="5.5" height="5.5" rx="1" />
    </svg>
  ) : (
    <svg aria-hidden="true" viewBox="0 0 10 10">
      <rect x="1.5" y="1.5" width="7" height="7" rx="1" />
    </svg>
  );

const CloseIcon = () => (
  <svg aria-hidden="true" viewBox="0 0 10 10">
    <line x1="2" y1="2" x2="8" y2="8" />
    <line x1="8" y1="2" x2="2" y2="8" />
  </svg>
);

interface WindowControlButtonProps {
  readonly type: ButtonType;
  readonly maximized: boolean;
  readonly onClick: () => void;
}

function WindowControlButton({
  type,
  maximized,
  onClick,
}: WindowControlButtonProps) {
  const label =
    type === "close"
      ? "关闭"
      : type === "maximize"
        ? maximized
          ? "还原"
          : "最大化"
        : "最小化";

  return (
    <button
      aria-label={label}
      className={`${styles.controlButton}${type === "close" ? ` ${styles.closeButton}` : ""}`}
      onClick={onClick}
      title={label}
      type="button"
    >
      {type === "minimize" ? (
        <MinimizeIcon />
      ) : type === "maximize" ? (
        <MaximizeIcon maximized={maximized} />
      ) : (
        <CloseIcon />
      )}
    </button>
  );
}

/** Cached layout shared across all WindowControls instances in the same window. */
let cachedLayout: { left: string[]; right: string[] } | null = null;
let layoutPromise: Promise<{ left: string[]; right: string[] }> | null = null;

function loadLayout(): Promise<{ left: string[]; right: string[] }> {
  if (cachedLayout !== null) return Promise.resolve(cachedLayout);
  if (layoutPromise !== null) return layoutPromise;
  layoutPromise = invoke<string>("get_window_button_layout")
    .then((raw) => parseButtonLayout(raw))
    .catch(() => parseButtonLayout("appmenu:close"))
    .then((result) => {
      cachedLayout = result;
      return result;
    });
  return layoutPromise;
}

export interface WindowControlsProps {
  /** Which side of the title bar to render buttons for. */
  readonly side: "left" | "right";
  /** Override the button layout for testing. */
  readonly buttonLayout?: string;
}

export function WindowControls({
  side,
  buttonLayout: buttonLayoutOverride,
}: WindowControlsProps) {
  const [buttons, setButtons] = useState<string[]>(() => {
    if (buttonLayoutOverride !== undefined) {
      const parsed = parseButtonLayout(buttonLayoutOverride);
      return parsed[side];
    }
    return cachedLayout !== null ? cachedLayout[side] : [];
  });
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    if (buttonLayoutOverride !== undefined) {
      setButtons(parseButtonLayout(buttonLayoutOverride)[side]);
      return;
    }
    void loadLayout().then((layout) => setButtons(layout[side]));
  }, [buttonLayoutOverride, side]);

  useEffect(() => {
    const appWindow = getCurrentWindow();
    void appWindow.isMaximized().then(setMaximized);
    const unlisten = appWindow.onResized(() => {
      void appWindow.isMaximized().then(setMaximized);
    });
    return () => {
      void unlisten.then((fn) => fn());
    };
  }, []);

  if (buttons.length === 0) return null;

  const appWindow = getCurrentWindow();

  function handleAction(type: ButtonType): void {
    if (type === "minimize") void appWindow.minimize();
    else if (type === "maximize") void appWindow.toggleMaximize();
    else void appWindow.close();
  }

  return (
    <div className={styles.windowControls}>
      {buttons.map((btn) => (
        <WindowControlButton
          key={btn}
          maximized={maximized}
          onClick={() => handleAction(btn as ButtonType)}
          type={btn as ButtonType}
        />
      ))}
    </div>
  );
}
