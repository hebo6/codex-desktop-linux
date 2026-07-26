import { getCurrentWindow } from "@tauri-apps/api/window";

export interface WindowFocusSource {
  current(): Promise<boolean>;
  subscribe(onChange: (focused: boolean) => void): Promise<() => void>;
}

export const windowFocusSource: WindowFocusSource = Object.freeze({
  current() {
    return getCurrentWindow().isFocused();
  },
  subscribe(onChange: (focused: boolean) => void) {
    return getCurrentWindow().onFocusChanged(({ payload }) => onChange(payload));
  },
});
