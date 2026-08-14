import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";

import { getCurrentWindow } from "@tauri-apps/api/window";

import styles from "./ApplicationContextMenus.module.css";

interface WindowMenuState {
  readonly maximized: boolean;
  readonly x: number;
  readonly y: number;
}

interface MenuPosition {
  readonly left: number;
  readonly top: number;
}

export function ApplicationContextMenus() {
  const menuRef = useRef<HTMLDivElement>(null);
  const openRequestRef = useRef(0);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const [menu, setMenu] = useState<WindowMenuState | null>(null);
  const [menuPosition, setMenuPosition] = useState<MenuPosition | null>(null);

  useEffect(() => {
    const appWindow = getCurrentWindow();
    const handleContextMenu = (event: MouseEvent) => {
      event.preventDefault();
      const requestId = ++openRequestRef.current;
      if (!isWindowMenuTarget(event.target)) {
        const returnFocus = menuRef.current === null
          ? null
          : returnFocusRef.current;
        setMenu(null);
        returnFocus?.focus();
        return;
      }
      const activeElement = document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
      if (
        activeElement === null ||
        menuRef.current?.contains(activeElement) !== true
      ) {
        returnFocusRef.current = activeElement;
      }
      const { clientX: x, clientY: y } = event;
      setMenu(null);
      void appWindow.isMaximized().then((maximized) => {
        if (requestId !== openRequestRef.current) {
          return;
        }
        setMenuPosition(null);
        setMenu({ maximized, x, y });
      }, () => {
        if (requestId === openRequestRef.current) {
          setMenu(null);
        }
      });
    };
    document.addEventListener("contextmenu", handleContextMenu);
    return () => {
      openRequestRef.current += 1;
      document.removeEventListener("contextmenu", handleContextMenu);
    };
  }, []);

  useLayoutEffect(() => {
    if (menu === null || menuRef.current === null) {
      return;
    }
    const bounds = menuRef.current.getBoundingClientRect();
    setMenuPosition(fitMenuToViewport(menu.x, menu.y, bounds));
    menuRef.current.querySelector<HTMLButtonElement>("button")?.focus();
  }, [menu]);

  useEffect(() => {
    if (menu === null) {
      return;
    }
    const closeFromPointer = (event: PointerEvent) => {
      if (
        event.target instanceof Node &&
        menuRef.current?.contains(event.target)
      ) {
        return;
      }
      closeMenuAndRestoreFocus(setMenu, returnFocusRef.current);
    };
    const closeFromWindow = () => setMenu(null);
    const closeFromScroll = () =>
      closeMenuAndRestoreFocus(setMenu, returnFocusRef.current);
    document.addEventListener("pointerdown", closeFromPointer);
    document.addEventListener("scroll", closeFromScroll, true);
    window.addEventListener("blur", closeFromWindow);
    window.addEventListener("resize", closeFromScroll);
    return () => {
      document.removeEventListener("pointerdown", closeFromPointer);
      document.removeEventListener("scroll", closeFromScroll, true);
      window.removeEventListener("blur", closeFromWindow);
      window.removeEventListener("resize", closeFromScroll);
    };
  }, [menu]);

  const closeAndRun = (action: () => Promise<void>) => {
    if (menu === null) {
      return;
    }
    closeMenuAndRestoreFocus(setMenu, returnFocusRef.current);
    void action();
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (menu === null) {
      return;
    }
    const menuItems = Array.from(
      event.currentTarget.querySelectorAll<HTMLButtonElement>("button"),
    );
    const currentIndex = menuItems.indexOf(
      document.activeElement as HTMLButtonElement,
    );
    let nextIndex: number | null = null;
    if (event.key === "ArrowDown") {
      nextIndex = currentIndex < 0 ? 0 : (currentIndex + 1) % menuItems.length;
    } else if (event.key === "ArrowUp") {
      nextIndex = currentIndex < 0
        ? menuItems.length - 1
        : (currentIndex - 1 + menuItems.length) % menuItems.length;
    } else if (event.key === "Home") {
      nextIndex = 0;
    } else if (event.key === "End") {
      nextIndex = menuItems.length - 1;
    } else if (event.key === "Escape" || event.key === "Tab") {
      event.preventDefault();
      event.stopPropagation();
      closeMenuAndRestoreFocus(setMenu, returnFocusRef.current);
      return;
    }
    if (nextIndex !== null && menuItems.length > 0) {
      event.preventDefault();
      menuItems[nextIndex]?.focus();
    }
  };

  if (menu === null) {
    return null;
  }

  const appWindow = getCurrentWindow();
  return createPortal(
    <div
      aria-label="窗口操作"
      className={styles.windowMenu}
      onKeyDown={handleKeyDown}
      ref={menuRef}
      role="menu"
      style={{
        left: menuPosition?.left ?? menu.x,
        top: menuPosition?.top ?? menu.y,
        visibility: menuPosition === null ? "hidden" : "visible",
      }}
    >
      <button
        onClick={() => closeAndRun(() => appWindow.toggleMaximize())}
        role="menuitem"
        type="button"
      >
        {menu.maximized ? "还原" : "最大化"}
      </button>
      <button
        onClick={() => closeAndRun(() => appWindow.minimize())}
        role="menuitem"
        type="button"
      >
        最小化
      </button>
    </div>,
    document.body,
  );
}

function isWindowMenuTarget(target: EventTarget | null): boolean {
  const element = target instanceof Element
    ? target
    : target instanceof Node
      ? target.parentElement
      : null;
  const region = element?.closest<HTMLElement>("[data-window-menu-region]");
  if (region === undefined || region === null) {
    return false;
  }
  return region.dataset.windowMenuRegion === "deep" || region === element;
}

function closeMenuAndRestoreFocus(
  setMenu: React.Dispatch<React.SetStateAction<WindowMenuState | null>>,
  returnFocus: HTMLElement | null,
): void {
  setMenu(null);
  returnFocus?.focus();
}

function fitMenuToViewport(
  x: number,
  y: number,
  bounds: Pick<DOMRect, "height" | "width">,
): MenuPosition {
  const margin = 8;
  return {
    left: Math.max(
      margin,
      Math.min(x, window.innerWidth - bounds.width - margin),
    ),
    top: Math.max(
      margin,
      Math.min(y, window.innerHeight - bounds.height - margin),
    ),
  };
}
