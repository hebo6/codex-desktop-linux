import "@testing-library/jest-dom/vitest";

import { cleanup } from "@testing-library/react";
import { afterEach, vi } from "vitest";

afterEach(() => {
  cleanup();
});

// Mock Tauri 2 window API
vi.mock("@tauri-apps/api/window", () => {
  const mockWindow = {
    isMaximized: vi.fn().mockResolvedValue(false),
    onResized: vi.fn().mockResolvedValue(vi.fn()),
    minimize: vi.fn().mockResolvedValue(undefined),
    toggleMaximize: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    startResizeDragging: vi.fn().mockResolvedValue(undefined),
  };
  return {
    getCurrentWindow: () => mockWindow,
  };
});

// Mock Tauri 2 core API
vi.mock("@tauri-apps/api/core", () => {
  return {
    invoke: vi.fn().mockImplementation((cmd: string) => {
      if (cmd === "get_window_button_layout") {
        return Promise.resolve("appmenu:close");
      }
      return Promise.resolve();
    }),
  };
});
