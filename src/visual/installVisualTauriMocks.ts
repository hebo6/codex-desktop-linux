import { mockIPC, mockWindows } from "@tauri-apps/api/mocks";

export function installVisualTauriMocks() {
  mockWindows("visual-regression");
  mockIPC((command) => {
    if (command === "get_window_button_layout") {
      return "appmenu:close";
    }
    if (command === "plugin:window|is_maximized") {
      return false;
    }
    throw new Error(`视觉场景不支持 Tauri 命令：${command}`);
  }, { shouldMockEvents: true });
}
