import { listen } from "@tauri-apps/api/event";

import {
  parseThemePreference,
  type ThemePreference,
} from "./preferences";
import { tauriIpc, type TauriIpc } from "./tauriIpc";

const LOAD_THEME_PREFERENCE_COMMAND = "load_theme_preference";
const THEME_PREFERENCE_CHANGED_EVENT = "theme-preference-changed";

export interface ThemePreferenceEventApi {
  listen(
    event: string,
    handler: (event: { readonly payload: unknown }) => void,
  ): Promise<() => void>;
}

export interface ThemePreferenceSource {
  load(): Promise<ThemePreference>;
  subscribe(onChange: (theme: ThemePreference) => void): Promise<() => void>;
}

const tauriThemePreferenceEvents: ThemePreferenceEventApi = {
  listen(event, handler) {
    return listen<unknown>(event, handler);
  },
};

export function createThemePreferenceSource(
  ipc: Pick<TauriIpc, "invoke"> = tauriIpc,
  events: ThemePreferenceEventApi = tauriThemePreferenceEvents,
): ThemePreferenceSource {
  return {
    async load() {
      return parseThemePreference(
        await ipc.invoke<unknown>(LOAD_THEME_PREFERENCE_COMMAND, {}),
      );
    },
    async subscribe(onChange) {
      return events.listen(THEME_PREFERENCE_CHANGED_EVENT, (event) => {
        onChange(parseThemePreference(event.payload));
      });
    },
  };
}

export const themePreferenceSource = createThemePreferenceSource();
