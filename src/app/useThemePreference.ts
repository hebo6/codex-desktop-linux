import { useEffect } from "react";

import {
  themePreferenceSource,
  type ThemePreferenceSource,
} from "../transport/themePreference";
import { applyThemePreference } from "./theme";

export function useThemePreference(
  source: ThemePreferenceSource = themePreferenceSource,
): void {
  useEffect(() => {
    let active = true;
    let release: (() => void) | null = null;
    let eventRevision = 0;

    void (async () => {
      try {
        const unsubscribe = await source.subscribe((theme) => {
          if (!active) return;
          eventRevision += 1;
          applyThemePreference(theme);
        });
        if (!active) {
          unsubscribe();
          return;
        }
        release = unsubscribe;
      } catch {
        // 初始主题仍可独立加载
      }

      const loadRevision = eventRevision;
      try {
        const theme = await source.load();
        if (active && eventRevision === loadRevision) {
          applyThemePreference(theme);
        }
      } catch {
        // 保留 CSS 默认的跟随系统主题
      }
    })();

    return () => {
      active = false;
      release?.();
    };
  }, [source]);
}
